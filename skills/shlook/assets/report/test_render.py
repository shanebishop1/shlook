#!/usr/bin/env python3
"""Tests for the report renderer. Run: python3 -m unittest discover -s <dir>"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import re
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("shlook_report_render", HERE / "render.py")
assert SPEC and SPEC.loader
render = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(render)
TEMPLATE = render.Path(HERE / "report.html").read_text(encoding="utf-8")


def body(markdown: str) -> str:
    return render.MarkdownRenderer().render(markdown)


def document(markdown: str, **options: object) -> str:
    options.setdefault("template", TEMPLATE)
    return render.render_document(markdown, **options)


class InlineTests(unittest.TestCase):
    def test_emphasis(self) -> None:
        self.assertEqual(
            body("**bold** and *italic* and ***both***"),
            "<p><strong>bold</strong> and <em>italic</em> and <strong><em>both</em></strong></p>",
        )

    def test_underscore_keeps_snake_case(self) -> None:
        html = body("set `max_body_size` in _config_ or __settings__")
        self.assertIn("<code>max_body_size</code>", html)
        self.assertIn("<em>config</em>", html)
        self.assertIn("<strong>settings</strong>", html)

    def test_inline_code_is_escaped(self) -> None:
        html = body("use `<div class=\"x\">` here")
        self.assertIn('<code>&lt;div class="x"&gt;</code>', html)

    def test_links(self) -> None:
        html = body("see [the docs](https://example.com/a?b=1&c=2) now")
        self.assertIn(
            '<a href="https://example.com/a?b=1&amp;c=2">the docs</a>',
            html,
        )
        self.assertIn(
            '<a href="mailto:owner@example.com">mailto:owner@example.com</a>',
            body("<mailto:owner@example.com>"),
        )

    def test_unsafe_link_stays_text(self) -> None:
        html = body("[click](javascript:alert(1)) and [x](data:text/html,hi)")
        self.assertNotIn("<a ", html)
        self.assertIn("alert(1)", html)

    def test_source_html_is_escaped(self) -> None:
        html = body('<script>alert("x")</script> & <b>bold</b>')
        self.assertNotIn("<script>", html)
        self.assertNotIn("<b>", html)
        self.assertIn('&lt;script&gt;alert("x")&lt;/script&gt;', html)
        self.assertIn("&amp;", html)

    def test_alternative_link_syntax_not_linked(self) -> None:
        html = body("[text][ref] <not a tag>")
        self.assertNotIn("<a ", html)
        self.assertIn("&lt;not a tag&gt;", html)


class BlockTests(unittest.TestCase):
    def test_headings(self) -> None:
        html = body("## Findings ##\n\n### Detail\n\n## Findings ##")
        self.assertIn('<h2 id="findings">Findings</h2>', html)
        self.assertIn('<h3 id="detail">Detail</h3>', html)
        self.assertIn('<h2 id="findings-2">Findings</h2>', html)

    def test_paragraph_joins_lines(self) -> None:
        html = body("one line\ntwo lines\n\nsecond paragraph")
        self.assertEqual(html, "<p>one line\ntwo lines</p>\n<p>second paragraph</p>")

    def test_horizontal_rule(self) -> None:
        self.assertIn("<hr>", body("above\n\n---\n\nbelow"))

    def test_blockquote(self) -> None:
        html = body("> **Note:** keep it short\n> and in one voice")
        self.assertEqual(
            html,
            "<blockquote><p><strong>Note:</strong> keep it short\nand in one voice</p></blockquote>",
        )

    def test_blockquote_survives_blank_line(self) -> None:
        html = body("> first\n\n> second")
        self.assertEqual(
            html,
            "<blockquote><p>first</p>\n<p>second</p></blockquote>",
        )

    def test_fenced_code_with_language(self) -> None:
        html = body("```bash\necho '<ok>' && exit 0\n```")
        self.assertEqual(
            html,
            '<pre><code class="language-bash">echo \'&lt;ok&gt;\' &amp;&amp; exit 0</code></pre>',
        )

    def test_fenced_code_keeps_blank_lines(self) -> None:
        html = body("```\na\n\nb\n```")
        self.assertIn("<code>a\n\nb</code>", html)

    def test_unordered_and_ordered_lists(self) -> None:
        html = body("- one\n- two\n\n1. first\n2. second")
        self.assertEqual(
            html,
            "<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>",
        )

    def test_ordered_list_start(self) -> None:
        self.assertIn('<ol start="3">', body("3. third\n4. fourth"))

    def test_nested_list(self) -> None:
        html = body("- outer\n  - inner\n  - inner two\n- last")
        self.assertIn("<li>outer\n<ul>\n<li>inner</li>\n<li>inner two</li>\n</ul></li>", html)

    def test_list_continuation_line(self) -> None:
        html = body("1. hand the card to the composer, like\n   the existing question card")
        self.assertIn("<li>hand the card to the composer, like\nthe existing question card</li>", html)

    def test_list_with_following_paragraph(self) -> None:
        html = body("- one\n\nafter the list")
        self.assertIn("</ul>\n<p>after the list</p>", html)

    def test_table(self) -> None:
        html = body(
            "| Capability | Route |\n"
            "| :--- | ---: |\n"
            "| Compact | `POST /x` |\n"
            "| Rename | a `b\\|c` cell |\n"
        )
        self.assertIn('<div class="table-scroll"><table>', html)
        self.assertIn('<th>Capability</th>', html)
        self.assertIn('<th class="ta-r">Route</th>', html)
        self.assertIn('<td>Compact</td>', html)
        self.assertIn("<td class=\"ta-r\"><code>POST /x</code></td>", html)
        self.assertIn("a <code>b|c</code> cell", html)
        self.assertIn("</tbody>\n</table></div>", html)

    def test_short_row_is_padded(self) -> None:
        html = body("| a | b | c |\n| --- | --- | --- |\n| 1 |")
        self.assertIn("<tr><td>1</td><td></td><td></td></tr>", html)

    def test_pipe_text_without_delimiter_is_a_paragraph(self) -> None:
        html = body("a | b\n---\n")
        self.assertNotIn("<table>", html)
        self.assertIn("<p>a | b</p>", html)
        self.assertIn("<hr>", html)


class DocumentTests(unittest.TestCase):
    def test_header_and_styles(self) -> None:
        html = document(
            "# Real title\n\nBody text.\n",
            eyebrow="Research · Systems",
            date="1 Jan 2026",
        )
        self.assertIn('<header class="doc">', html)
        self.assertIn('<div class="eyebrow">Research · Systems</div>', html)
        self.assertIn("<h1>Real title</h1>", html)
        self.assertIn('<div class="meta">1 Jan 2026</div>', html)
        self.assertIn("<title>Real title</title>", html)
        self.assertNotIn("<h1 id=", html)
        self.assertIn("Body text.", html)
        self.assertIn("<style>", html)
        self.assertIn("max-width: 52rem", html)
        self.assertIn("prefers-color-scheme: dark", html)
        self.assertIn("thead th {", html)
        self.assertIn("position: sticky", html)
        self.assertIn("@media print", html)

    def test_explicit_title_replaces_leading_heading(self) -> None:
        html = document("# Same title\n\nBody.\n", title="Same title")
        self.assertEqual(html.count("Same title"), 2)
        self.assertNotIn('id="same-title"', html)

    def test_explicit_title_keeps_different_heading(self) -> None:
        html = document("# Subtitle\n\nBody.\n", title="Report")
        self.assertIn("<h1>Report</h1>", html)
        self.assertIn('id="subtitle"', html)

    def test_front_matter(self) -> None:
        html = document(
            "---\ntitle: Front title\neyebrow: Research\ndate: 2026-02-03\n---\n\nBody.\n"
        )
        self.assertIn("<h1>Front title</h1>", html)
        self.assertIn('<div class="eyebrow">Research</div>', html)
        self.assertIn('<div class="meta">3 Feb 2026</div>', html)
        self.assertNotIn("---", html)

    def test_title_falls_back_to_file_name(self) -> None:
        html = document("Body only.\n", fallback_title="dashfleet-report")
        self.assertIn("<h1>Dashfleet report</h1>", html)

    def test_title_and_eyebrow_are_escaped(self) -> None:
        html = document("Body.\n", title='A <b>"title"</b>', eyebrow="<x>")
        self.assertIn("<h1>A &lt;b&gt;&quot;title&quot;&lt;/b&gt;</h1>", html)
        self.assertIn("&lt;x&gt;", html)
        self.assertNotIn("<b>", html)


class CliTests(unittest.TestCase):
    def test_render_file_writes_index_html(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "weekly-notes.md"
            source.write_text("# Weekly notes\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n", encoding="utf-8")
            target = render.render_file(source, root / "out")
            self.assertEqual(target, root / "out" / "index.html")
            html = target.read_text(encoding="utf-8")
            self.assertIn("<h1>Weekly notes</h1>", html)
            self.assertIn('class="table-scroll"', html)
            self.assertIn('<div class="meta">', html)

    def test_front_matter_date_beats_file_mtime(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "dated.md"
            source.write_text("---\ndate: 2026-02-03\n---\n\nBody.\n", encoding="utf-8")
            html = render.render_file(source, root / "out").read_text(encoding="utf-8")
            self.assertIn('<div class="meta">3 Feb 2026</div>', html)

    def test_main_renders_to_outdir(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "notes.md"
            source.write_text("Body without a heading.\n", encoding="utf-8")
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = render.main([str(source), str(root / "out"), "--title", "Notes"])
            self.assertEqual(code, 0)
            self.assertTrue((root / "out" / "index.html").is_file())
            self.assertIn("index.html", stdout.getvalue())

    def test_main_reports_missing_input(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                code = render.main([str(Path(directory) / "missing.md"), str(Path(directory) / "out")])
            self.assertEqual(code, 2)
            self.assertIn("cannot read", stderr.getvalue())

    def test_template_placeholders_are_all_used(self) -> None:
        names = set(re.findall(r"\{\{([A-Z]+)\}\}", TEMPLATE))
        self.assertEqual(names, {"TITLE", "EYEBROW", "DATE", "BODY"})


if __name__ == "__main__":
    unittest.main()
