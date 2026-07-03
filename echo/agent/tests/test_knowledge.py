"""Knowledge VFS tests. Uses the KNOWLEDGE_*_DIR env overrides so the suite
is hermetic and independent of where the module file sits — the container
path bug (here.parents[1] out of range at /app/knowledge.py) slipped past
the earlier tests precisely because they relied on the checkout layout."""

import importlib

import pytest


@pytest.fixture
def knowledge_dirs(tmp_path, monkeypatch):
    docs = tmp_path / "docs"
    (docs / "features").mkdir(parents=True)
    (docs / "features" / "portal-editor.md").write_text(
        "# Portal editor\nThe key terms field feeds transcription.\n", encoding="utf-8"
    )
    (docs / "index.md").write_text("# Docs\n", encoding="utf-8")

    skills = tmp_path / "skills"
    skills.mkdir()
    (skills / "onboarding.md").write_text(
        "---\nname: onboarding\ndescription: Guide setup.\n"
        "when_to_use: setup questions.\n---\nbody\n",
        encoding="utf-8",
    )
    (skills / "no-frontmatter.md").write_text("just a body\n", encoding="utf-8")

    monkeypatch.setenv("KNOWLEDGE_DOCS_DIR", str(docs))
    monkeypatch.setenv("KNOWLEDGE_SKILLS_DIR", str(skills))
    import knowledge

    return importlib.reload(knowledge)


def test_docs_root_resolves_without_index_error(knowledge_dirs):
    # Regression: must not raise regardless of the module's own path depth.
    assert knowledge_dirs.docs_root() is not None
    assert sorted(knowledge_dirs.list_docs()) == ["features/portal-editor.md", "index.md"]


def test_grep_and_read(knowledge_dirs):
    hits = knowledge_dirs.grep_docs("key terms")
    assert hits and hits[0]["path"] == "features/portal-editor.md"
    body = knowledge_dirs.read_doc("features/portal-editor.md")
    assert "Portal editor" in body
    # Path traversal is refused.
    with pytest.raises(ValueError):
        knowledge_dirs.read_doc("../../etc/passwd")


def test_skill_catalog_requires_full_frontmatter(knowledge_dirs):
    catalog = knowledge_dirs.skill_catalog()
    names = [s["name"] for s in catalog]
    assert names == ["onboarding"]  # the frontmatter-less file is excluded
    assert "Guide setup." in knowledge_dirs.prompt_section()


def test_prompt_section_links_published_docs_when_base_url_set(knowledge_dirs, monkeypatch):
    monkeypatch.setenv("DOCS_BASE_URL", "https://docs.echo-next.dembrane.com/")
    section = knowledge_dirs.prompt_section()
    # Trailing slash is normalized; the .md -> .html mapping is spelled out.
    assert "https://docs.echo-next.dembrane.com/users/host/index.html" in section
    assert "Cite the doc path you used." not in section


def test_prompt_section_cites_bare_paths_without_base_url(knowledge_dirs, monkeypatch):
    monkeypatch.delenv("DOCS_BASE_URL", raising=False)
    section = knowledge_dirs.prompt_section()
    assert "Cite the doc path you used." in section


def test_missing_corpus_degrades_gracefully(tmp_path, monkeypatch):
    monkeypatch.setenv("KNOWLEDGE_DOCS_DIR", str(tmp_path / "nope"))
    monkeypatch.setenv("KNOWLEDGE_SKILLS_DIR", str(tmp_path / "nope"))
    import knowledge

    k = importlib.reload(knowledge)
    assert k.list_docs() == []
    assert k.skill_catalog() == []
    assert k.prompt_section() == ""
