#!/usr/bin/env python3
import json
import subprocess
import os

def run_cmd(cmd, cwd=None):
    print(f"\nRunning command: {' '.join(cmd)} in {cwd or os.getcwd()}")
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if res.returncode != 0:
        print(f"Command exited with code {res.returncode}")
        if res.stdout:
            print("STDOUT:", res.stdout)
        if res.stderr:
            print("STDERR:", res.stderr)
    else:
        print("Command completed successfully")
    return res

def patch_python_project(dir_path, uses_requirements_lock=False):
    print(f"\n==================================================")
    print(f"Auditing and Patching Python project: {dir_path}")
    print(f"==================================================")
    
    # 1. Ensure pip-audit is installed in the uv environment or run it
    run_cmd(["uv", "pip", "install", "pip-audit"], cwd=dir_path)
    
    # 2. Run pip-audit to find vulnerabilities
    # Run uv run pip-audit --format json
    res = run_cmd(["uv", "run", "pip-audit", "--format", "json"], cwd=dir_path)
    
    stdout = res.stdout.strip()
    if not stdout:
        print("No pip-audit output received. Skipping.")
        return
        
    audit_data = None
    try:
        audit_data = json.loads(stdout)
    except Exception as e:
        print(f"Failed to parse direct JSON: {e}")
        # Try finding JSON lines or array in output
        for line in stdout.splitlines():
            line_str = line.strip()
            if line_str.startswith("[") or line_str.startswith("{"):
                try:
                    audit_data = json.loads(line_str)
                    break
                except Exception:
                    pass

    if not audit_data:
        print("Could not parse pip-audit output as JSON.")
        return

    vulnerable_pkgs = set()
    if isinstance(audit_data, list):
        for dep in audit_data:
            vulns = dep.get("vulns", [])
            if vulns:
                vulnerable_pkgs.add(dep.get("name"))
    elif isinstance(audit_data, dict) and "dependencies" in audit_data:
        for dep in audit_data.get("dependencies", []):
            vulns = dep.get("vulns", [])
            if vulns:
                vulnerable_pkgs.add(dep.get("name"))

    if not vulnerable_pkgs:
        print("✅ No vulnerable Python packages found.")
        return

    print(f"🚨 Found {len(vulnerable_pkgs)} vulnerable Python packages: {vulnerable_pkgs}")
    for pkg in sorted(list(vulnerable_pkgs)):
        print(f"Upgrading {pkg}...")
        # uv add will find the latest version, update pyproject.toml constraints, and regenerate uv.lock
        run_cmd(["uv", "add", pkg], cwd=dir_path)

    # Clean up sync
    run_cmd(["uv", "sync"], cwd=dir_path)

    if uses_requirements_lock:
        print("Regenerating requirements.lock and requirements-dev.lock...")
        run_cmd(["uv", "export", "--no-dev", "--format", "requirements-txt", "-o", "requirements.lock"], cwd=dir_path)
        run_cmd(["uv", "export", "--dev", "--format", "requirements-txt", "-o", "requirements-dev.lock"], cwd=dir_path)


def patch_node_project(dir_path):
    print(f"\n==================================================")
    print(f"Auditing and Patching Node project: {dir_path}")
    print(f"==================================================")
    
    res = run_cmd(["pnpm", "audit", "--json"], cwd=dir_path)
    stdout = res.stdout.strip()
    if not stdout:
        print("No audit output from pnpm.")
        return

    vulnerable_pkgs = set()
    try:
        data = json.loads(stdout)
        if "vulnerabilities" in data:
            for pkg, info in data["vulnerabilities"].items():
                severity = info.get("severity", "").lower()
                if severity in ["high", "critical"]:
                    vulnerable_pkgs.add(pkg)
        elif "advisories" in data:
            for adv_id, info in data["advisories"].items():
                severity = info.get("severity", "").lower()
                if severity in ["high", "critical"]:
                    vulnerable_pkgs.add(info.get("module_name"))
    except json.JSONDecodeError:
        # Check JSON lines
        for line in stdout.splitlines():
            try:
                line_data = json.loads(line)
                if "advisory" in line_data:
                    adv = line_data["advisory"]
                    severity = adv.get("severity", "").lower()
                    if severity in ["high", "critical"]:
                        vulnerable_pkgs.add(adv.get("module_name"))
                elif "vulnerability" in line_data:
                    vuln = line_data["vulnerability"]
                    severity = vuln.get("severity", "").lower()
                    if severity in ["high", "critical"]:
                        vulnerable_pkgs.add(vuln.get("package"))
            except Exception:
                pass

    if not vulnerable_pkgs:
        print("✅ No high/critical vulnerable Node packages found.")
        return

    print(f"🚨 Found {len(vulnerable_pkgs)} high/critical vulnerable Node packages: {vulnerable_pkgs}")
    for pkg in sorted(list(vulnerable_pkgs)):
        print(f"Upgrading Node package: {pkg}")
        # Run pnpm update to upgrade the package
        run_cmd(["pnpm", "update", pkg], cwd=dir_path)
        
    # Re-run install to clean up lockfile completely
    run_cmd(["pnpm", "install"], cwd=dir_path)


def main():
    workspace = os.environ.get("GITHUB_WORKSPACE", "/tmp/echo")
    
    # 1. Patch echo/server (Python, uses requirements.lock)
    server_dir = os.path.join(workspace, "echo/server")
    if os.path.exists(server_dir):
        patch_python_project(server_dir, uses_requirements_lock=True)
        
    # 2. Patch echo/agent (Python, uses uv.lock only)
    agent_dir = os.path.join(workspace, "echo/agent")
    if os.path.exists(agent_dir):
        patch_python_project(agent_dir, uses_requirements_lock=False)
        
    # 3. Patch echo/frontend (JS/TS)
    frontend_dir = os.path.join(workspace, "echo/frontend")
    if os.path.exists(frontend_dir):
        patch_node_project(frontend_dir)

if __name__ == "__main__":
    main()
