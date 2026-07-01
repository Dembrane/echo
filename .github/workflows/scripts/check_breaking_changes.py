#!/usr/bin/env python3
import os
import re
import json
import tomllib
import subprocess

def run_cmd(cmd, cwd=None):
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return res.stdout.strip()

def get_file_content_from_main(file_path):
    return run_cmd(["git", "show", f"origin/main:{file_path}"])

def parse_package_json_deps(content_str):
    try:
        data = json.loads(content_str)
        deps = {}
        for dep_type in ["dependencies", "devDependencies", "peerDependencies"]:
            if dep_type in data:
                for k, v in data[dep_type].items():
                    deps[k] = v
        return deps
    except Exception:
        return {}

def parse_pyproject_toml_deps(content_str):
    try:
        data = tomllib.loads(content_str)
        deps = {}
        # Parse standard PEP 508 dependencies list
        project = data.get("project", {})
        dependencies = project.get("dependencies", [])
        for dep in dependencies:
            # Clean comments and extra spaces
            dep_clean = dep.split("#")[0].strip()
            # Simple parsing: find package name and constraint
            # e.g., "fastapi==0.109.*" or "boto3>=1.37.*"
            match = re.match(r"^([a-zA-Z0-9_\-]+[a-zA-Z0-9])\s*([>=<=~!]*)\s*([0-9\.\*a-zA-Z\-]+)", dep_clean)
            if match:
                pkg_name = match.group(1).lower()
                constraint = match.group(2) + match.group(3)
                deps[pkg_name] = constraint
        return deps
    except Exception as e:
        print(f"Error parsing pyproject.toml: {e}")
        return {}

def analyze_version_jump(old_ver, new_ver):
    # Clean version strings (strip ^, ~, >=, ==, etc.)
    def clean_ver(v):
        v = re.sub(r"^[>=<~!\^s]+", "", v).strip()
        # strip .*
        v = v.replace(".*", "")
        return v

    old_clean = clean_ver(old_ver)
    new_clean = clean_ver(new_ver)
    
    # Try parsing semantic parts
    try:
        old_parts = [int(p) for p in re.findall(r"\d+", old_clean)[:3]]
        new_parts = [int(p) for p in re.findall(r"\d+", new_clean)[:3]]
        
        while len(old_parts) < 3: old_parts.append(0)
        while len(new_parts) < 3: new_parts.append(0)
        
        if new_parts[0] > old_parts[0]:
            return "MAJOR (High Risk)", "🚨 Potential breaking changes. Major version bump requires careful testing."
        elif new_parts[1] > old_parts[1]:
            return "MINOR (Medium/Low Risk)", "⚠️ Feature additions or deprecations possible. Low/Medium risk."
        elif new_parts[2] > old_parts[2]:
            return "PATCH (Safe)", "✅ Standard bug/security patch. Extremely safe."
    except Exception:
        pass
    
    return "UNKNOWN", "🔍 Version format unrecognized. Manual verification recommended."

def search_usages(pkg_name, workspace):
    # Search for occurrences of package name in source files to assess impact
    # e.g., import, require, etc.
    # Convert package-name (kebab) to snake_case or standard naming
    patterns = [pkg_name, pkg_name.replace("-", "_")]
    count = 0
    # Search python and js/ts files
    for root, _, files in os.walk(workspace):
        # Exclude node_modules, .git, .venv, build, dist, lockfiles
        if any(p in root for p in ["node_modules", ".git", ".venv", "build", "dist", "lock"]):
            continue
        for file in files:
            if file.endswith((".py", ".ts", ".tsx", ".js", ".jsx")):
                path = os.path.join(root, file)
                try:
                    with open(path, "r", errors="ignore") as f:
                        content = f.read()
                        for pat in patterns:
                            if re.search(r"\b" + re.escape(pat) + r"\b", content):
                                count += 1
                                break
                except Exception:
                    pass
    return count

def main():
    workspace = os.environ.get("GITHUB_WORKSPACE", "/tmp/echo")
    
    reports = []
    
    files_to_check = [
        ("echo/frontend/package.json", "Node.js (Frontend)", parse_package_json_deps),
        ("echo/server/pyproject.toml", "Python (Server)", parse_pyproject_toml_deps),
        ("echo/agent/pyproject.toml", "Python (Agent)", parse_pyproject_toml_deps)
    ]
    
    for rel_path, label, parser in files_to_check:
        full_path = os.path.join(workspace, rel_path)
        if not os.path.exists(full_path):
            continue
            
        try:
            with open(full_path, "r") as f:
                new_content = f.read()
            old_content = get_file_content_from_main(rel_path)
            
            if not old_content:
                continue
                
            old_deps = parser(old_content)
            new_deps = parser(new_content)
            
            file_changes = []
            for pkg, new_ver in new_deps.items():
                if pkg in old_deps:
                    old_ver = old_deps[pkg]
                    if old_ver != new_ver:
                        risk, note = analyze_version_jump(old_ver, new_ver)
                        usages = search_usages(pkg, workspace)
                        file_changes.append({
                            "package": pkg,
                            "old": old_ver,
                            "new": new_ver,
                            "risk": risk,
                            "note": note,
                            "usages": usages
                        })
                        
            if file_changes:
                reports.append((label, rel_path, file_changes))
        except Exception as e:
            print(f"Error checking {rel_path}: {e}")
            
    # Generate Markdown output
    markdown = []
    markdown.append("### 🔍 Security Patch Risk Analysis & Breaking Changes\n")
    
    if not reports:
        markdown.append("✅ No package constraints were modified in direct dependency manifests (`pyproject.toml` or `package.json`). All changes are transitive or lockfile-only.")
    else:
        markdown.append("This analysis automatically maps direct dependency upgrades against our codebase to evaluate breaking change risks:\n")
        for label, rel_path, changes in reports:
            markdown.append(f"#### 📦 {label} (`{rel_path}`)")
            markdown.append("| Package | Upgrade | Risk Level | Usages in Codebase | Guidance |")
            markdown.append("|---|---|---|---|---|")
            for c in sorted(changes, key=lambda x: x["package"]):
                usage_str = f"**{c['usages']} files**" if c['usages'] > 0 else "0 files (No Direct Import)"
                markdown.append(f"| `{c['package']}` | `{c['old']}` ➡️ `{c['new']}` | **{c['risk']}** | {usage_str} | {c['note']} |")
            markdown.append("")
            
    # Write to a file that can be read by GitHub Actions step
    report_path = os.path.join(workspace, "breaking_changes_report.md")
    with open(report_path, "w") as f:
        f.write("\n".join(markdown))
    print(f"Successfully generated risk analysis report at {report_path}")

if __name__ == "__main__":
    main()
