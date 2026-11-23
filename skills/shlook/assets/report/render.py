#!/usr/bin/env python3
"""Render a Markdown report into a styled, self-contained HTML page.

Usage:
    python3 render.py <input.md> <outdir> [--title TEXT] [--eyebrow TEXT] [--date TEXT]

Writes <outdir>/index.html from the sibling report.html template. The template
carries all CSS, so the published directory needs no other assets.

Supported Markdown: headings, paragraphs, emphasis, inline code, fenced code,
ordered/unordered lists (nested), tables with alignment, blockquotes, links,
autolinks, horizontal rules. Source HTML is always escaped: the page never
executes markup from the report.

Optional front matter may set `title`, `eyebrow` and `date` as `key: value`
lines between `---` markers. Command-line options win over front matter.

Python 3 standard library only.
"""

from __future__ import annotations

import argparse
import html
import re
import sys
from datetime import date as date_type
from datetime import datetime
from pathlib import Path

TEMPLATE_NAME = "report.html"
MONTHS = (
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
)

FENCE_RE = re.compile(r"^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$")
ATX_RE = re.compile(r"^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*$")
HR_RE = re.compile(r"^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$")
BLOCKQUOTE_RE = re.compile(r"^ {0,3}> ?(.*)$")
LIST_ITEM_RE = re.compile(r"^( *)([-+*]|\d{1,9}[.)])([ \t]+)(.*)$")
FRONT_MATTER_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)", re.S)
TOKEN_RE = re.compile(r"\x00(\d+)\x00")
CODE_SPAN_RE = re.compile(r"(?s)(`+)(?!`)(.+?)(?<!`)\1(?!`)")
LINK_RE = re.compile(r"\[([^\]]*)\]\(([^()\s]+)\)")
AUTOLINK_RE = re.compile(r"&lt;((?:https?://|mailto:)[^\s&]+)&gt;")
SCHEME_RE = re.compile(r"^([A-Za-z][A-Za-z0-9+.\-]*):")
SAFE_SCHEMES = {"http", "https", "mailto"}


class RenderError(Exception):
    """A report could not be read or rendered."""


def escape_text(value: str) -> str:
    """Escape text for HTML text nodes."""
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def escape_attr(value: str) -> str:
    """Escape text for HTML attribute values and single-line elements."""
    return escape_text(value).replace('"', "&quot;").replace("'", "&#39;")


def _safe_url(url: str) -> str | None:
    """Return an escaped href for a link target, or None when unsafe."""
    value = html.unescape(url).strip()
    if not value or any(character in value for character in "\"'<>`\\"):
        return None
    if any(character.isspace() for character in value):
        return None
    scheme = SCHEME_RE.match(value)
    if scheme and scheme.group(1).lower() not in SAFE_SCHEMES:
        return None
    return escape_attr(value)


def _emphasize(text: str) -> str:
    text = re.sub(r"(?s)\*\*\*(.+?)\*\*\*", r"<strong><em>\1</em></strong>", text)
    text = re.sub(r"(?s)\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    text = re.sub(r"(?s)(?<![\w])__(.+?)__(?![\w])", r"<strong>\1</strong>", text)
    text = re.sub(r"(?s)(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", text)
    text = re.sub(r"(?s)(?<![\w_])_(?!\s)(.+?)(?<!\s)_(?![\w_])", r"<em>\1</em>", text)
    text = re.sub(r"(?s)~~(.+?)~~", r"<del>\1</del>", text)
    return text


def render_inline(raw: str) -> str:
    """Render one run of inline Markdown, escaping all source HTML."""
    tokens: list[str] = []

    def protect(value: str) -> str:
        tokens.append(value)
        return f"\x00{len(tokens) - 1}\x00"

    def restore(fragment: str) -> str:
        for _ in range(8):
            if "\x00" not in fragment:
                break
            fragment = TOKEN_RE.sub(lambda match: tokens[int(match.group(1))], fragment)
        return fragment

    def anchor(label: str, url: str, literal: bool = False) -> str:
        href = escape_attr(url) if literal else _safe_url(url)
        if not href:
            return label
        inner = restore(_emphasize(label))
        return f'<a href="{href}">{inner}</a>'

    text = escape_text(raw)
    text = CODE_SPAN_RE.sub(lambda match: protect(f"<code>{match.group(2).strip()}</code>"), text)
    text = LINK_RE.sub(lambda match: protect(anchor(match.group(1), match.group(2))), text)
    text = AUTOLINK_RE.sub(
        lambda match: protect(anchor(match.group(1), match.group(1), literal=True)), text
    )
    return restore(_emphasize(text))


def _plain(text: str) -> str:
    """Strip inline Markdown for use in the document header."""
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = text.replace("`", "")
    text = re.sub(r"(\*\*|__)(.+?)\1", r"\2", text)
    text = re.sub(r"(\*|_)(.+?)\1", r"\2", text)
    return text.strip()


def _slug(text: str) -> str:
    plain = html.unescape(re.sub(r"<[^>]+>", "", text))
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-") or "section"


def _indent_of(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _split_row(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|") and not value.endswith("\\|"):
        value = value[:-1]
    return [cell.replace("\\|", "|").strip() for cell in re.split(r"(?<!\\)\|", value)]


def _is_delimiter_row(line: str) -> bool:
    if "|" not in line:
        return False
    cells = _split_row(line)
    return bool(cells) and all(re.fullmatch(r":?-+:?", cell) for cell in cells)


def _alignment(cell: str) -> str:
    left = cell.startswith(":")
    right = cell.endswith(":")
    if left and right:
        return "ta-c"
    if right:
        return "ta-r"
    return ""


def _cell_attr(alignment: str) -> str:
    return f' class="{alignment}"' if alignment else ""


def _tighten(fragment: str) -> str:
    """Drop the paragraph wrapper around the first paragraph of a list item."""
    value = fragment.strip()
    if value.startswith("<p>"):
        end = value.find("</p>")
        if end != -1:
            return value[3:end] + value[end + 4 :]
    return fragment


class MarkdownRenderer:
    """Render the supported Markdown subset to an HTML fragment."""

    def __init__(self) -> None:
        self._used_ids: dict[str, int] = {}

    # -- block level -----------------------------------------------------

    def render(self, source: str) -> str:
        text = source.replace("\r\n", "\n").replace("\r", "\n")
        return self._blocks(text.split("\n"))

    def _heading_id(self, text: str) -> str:
        base = _slug(text)
        count = self._used_ids.get(base, 0)
        self._used_ids[base] = count + 1
        return base if count == 0 else f"{base}-{count + 1}"

    def _table_start(self, lines: list[str], index: int) -> bool:
        return (
            index + 1 < len(lines)
            and "|" in lines[index]
            and _is_delimiter_row(lines[index + 1])
        )

    def _starts_block(self, lines: list[str], index: int) -> bool:
        line = lines[index]
        return bool(
            FENCE_RE.match(line)
            or ATX_RE.match(line)
            or HR_RE.match(line)
            or BLOCKQUOTE_RE.match(line)
            or LIST_ITEM_RE.match(line)
            or self._table_start(lines, index)
        )

    def _blocks(self, lines: list[str]) -> str:
        output: list[str] = []
        index = 0
        while index < len(lines):
            line = lines[index]
            if not line.strip():
                index += 1
                continue
            fence = FENCE_RE.match(line)
            if fence:
                chunk, index = self._fence(lines, index, fence)
                output.append(chunk)
                continue
            heading = ATX_RE.match(line)
            if heading:
                output.append(self._heading(heading))
                index += 1
                continue
            if HR_RE.match(line):
                output.append("<hr>")
                index += 1
                continue
            if BLOCKQUOTE_RE.match(line):
                chunk, index = self._blockquote(lines, index)
                output.append(chunk)
                continue
            if LIST_ITEM_RE.match(line):
                chunk, index = self._list(lines, index)
                output.append(chunk)
                continue
            if self._table_start(lines, index):
                chunk, index = self._table(lines, index)
                output.append(chunk)
                continue
            chunk, index = self._paragraph(lines, index)
            output.append(chunk)
        return "\n".join(output)

    def _heading(self, match: re.Match[str]) -> str:
        level = len(match.group(1))
        text = re.sub(r"[ \t]+#+[ \t]*$", "", match.group(2))
        rendered = render_inline(text)
        return f'<h{level} id="{self._heading_id(rendered)}">{rendered}</h{level}>'

    def _fence(self, lines: list[str], index: int, match: re.Match[str]) -> tuple[str, int]:
        marker = match.group(1)
        info = match.group(2).strip().split()[0] if match.group(2).strip() else ""
        language = re.sub(r"[^A-Za-z0-9_+-]", "", info)
        closing = re.compile(rf"^ {{0,3}}{re.escape(marker[0])}{{{len(marker)},}}[ \t]*$")
        index += 1
        body: list[str] = []
        while index < len(lines):
            if closing.match(lines[index]):
                index += 1
                break
            body.append(lines[index])
            index += 1
        attribute = f' class="language-{language}"' if language else ""
        return f"<pre><code{attribute}>{escape_text(chr(10).join(body))}</code></pre>", index

    def _blockquote(self, lines: list[str], index: int) -> tuple[str, int]:
        inner: list[str] = []
        while index < len(lines):
            match = BLOCKQUOTE_RE.match(lines[index])
            if not match:
                if (
                    not lines[index].strip()
                    and index + 1 < len(lines)
                    and BLOCKQUOTE_RE.match(lines[index + 1])
                ):
                    inner.append("")
                    index += 1
                    continue
                break
            inner.append(match.group(1))
            index += 1
        return f"<blockquote>{self._blocks(inner)}</blockquote>", index

    def _paragraph(self, lines: list[str], index: int) -> tuple[str, int]:
        body = [lines[index]]
        index += 1
        while index < len(lines) and lines[index].strip() and not self._starts_block(lines, index):
            body.append(lines[index])
            index += 1
        return f"<p>{render_inline(chr(10).join(body))}</p>", index

    def _table(self, lines: list[str], index: int) -> tuple[str, int]:
        headers = _split_row(lines[index])
        alignments = [_alignment(cell) for cell in _split_row(lines[index + 1])]
        index += 2
        if len(alignments) < len(headers):
            alignments += [""] * (len(headers) - len(alignments))
        alignments = alignments[: len(headers)]
        rows: list[list[str]] = []
        while index < len(lines) and lines[index].strip() and "|" in lines[index]:
            rows.append(_split_row(lines[index]))
            index += 1

        def row_html(cells: list[str], tag: str) -> str:
            padded = (cells + [""] * len(headers))[: len(headers)]
            return "<tr>" + "".join(
                f"<{tag}{_cell_attr(alignments[position])}>{render_inline(cell)}</{tag}>"
                for position, cell in enumerate(padded)
            ) + "</tr>"

        output = ['<div class="table-scroll"><table>', "<thead>", row_html(headers, "th"), "</thead>"]
        if rows:
            output.append("<tbody>")
            output.extend(row_html(cells, "td") for cells in rows)
            output.append("</tbody>")
        output.append("</table></div>")
        return "\n".join(output), index

    def _list(self, lines: list[str], index: int) -> tuple[str, int]:
        first = LIST_ITEM_RE.match(lines[index])
        assert first is not None
        indent = len(first.group(1))
        ordered = first.group(2)[0].isdigit()
        start = int(first.group(2)[:-1]) if ordered else 1
        items: list[str] = []
        while index < len(lines):
            match = LIST_ITEM_RE.match(lines[index])
            if not match or len(match.group(1)) != indent or match.group(2)[0].isdigit() != ordered:
                break
            content_column = match.end(3)
            item_lines = [match.group(4)]
            index += 1
            while index < len(lines):
                line = lines[index]
                if not line.strip():
                    lookahead = index
                    while lookahead < len(lines) and not lines[lookahead].strip():
                        lookahead += 1
                    if lookahead < len(lines) and _indent_of(lines[lookahead]) > indent:
                        item_lines.append("")
                        index += 1
                        continue
                    break
                if _indent_of(line) >= content_column:
                    item_lines.append(line[content_column:])
                    index += 1
                    continue
                if _indent_of(line) > indent and not LIST_ITEM_RE.match(line):
                    item_lines.append(line.strip())
                    index += 1
                    continue
                break
            items.append(f"<li>{_tighten(self._blocks(item_lines))}</li>")
            lookahead = index
            while lookahead < len(lines) and not lines[lookahead].strip():
                lookahead += 1
            nxt = LIST_ITEM_RE.match(lines[lookahead]) if lookahead < len(lines) else None
            if nxt and len(nxt.group(1)) == indent and nxt.group(2)[0].isdigit() == ordered:
                index = lookahead
                continue
            break
        tag = "ol" if ordered else "ul"
        attribute = f' start="{start}"' if ordered and start != 1 else ""
        return f"<{tag}{attribute}>\n" + "\n".join(items) + f"\n</{tag}>", index


def _split_front_matter(source: str) -> tuple[dict[str, str], str]:
    match = FRONT_MATTER_RE.match(source)
    if not match:
        return {}, source
    meta: dict[str, str] = {}
    for line in match.group(1).split("\n"):
        entry = re.match(r"^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(.*)$", line.strip())
        if not entry:
            continue
        key = entry.group(1).lower()
        if key in {"title", "eyebrow", "date"}:
            meta[key] = entry.group(2).strip().strip("'\"")
    return meta, source[match.end() :]


def _humanize(stem: str | None) -> str:
    if not stem:
        return ""
    words = re.sub(r"[-_]+", " ", stem).strip()
    return words[:1].upper() + words[1:] if words else ""


def _format_date(value: object) -> str:
    if isinstance(value, datetime):
        value = value.date()
    if isinstance(value, date_type):
        return f"{value.day} {MONTHS[value.month - 1]} {value.year}"
    text = str(value or "").strip()
    if not text:
        return _format_date(date_type.today())
    iso = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", text)
    if iso:
        try:
            return _format_date(datetime(int(iso.group(1)), int(iso.group(2)), int(iso.group(3))))
        except ValueError:
            return text
    return text


def render_document(
    source: str,
    *,
    title: str | None = None,
    eyebrow: str | None = None,
    date: str | None = None,
    fallback_title: str | None = None,
    fallback_date: object | None = None,
    template: str | None = None,
    template_path: Path | None = None,
) -> str:
    """Render Markdown source into a complete HTML document."""
    meta, body_source = _split_front_matter(source)
    lines = body_source.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    resolved_title = title or meta.get("title")
    leading_heading: int | None = None
    leading_text = ""
    for position, line in enumerate(lines):
        if not line.strip():
            continue
        heading = ATX_RE.match(line)
        if heading and len(heading.group(1)) == 1:
            leading_heading = position
            leading_text = _plain(re.sub(r"[ \t]+#+[ \t]*$", "", heading.group(2)))
        break
    if leading_heading is not None:
        if resolved_title is None:
            resolved_title = leading_text
            del lines[leading_heading]
        elif leading_text.casefold() == str(resolved_title).strip().casefold():
            del lines[leading_heading]

    resolved_title = (resolved_title or _humanize(fallback_title) or "Report").strip()
    resolved_eyebrow = (eyebrow or meta.get("eyebrow") or "Report").strip()
    resolved_date = _format_date(date or meta.get("date") or fallback_date)

    if template is None:
        path = template_path or Path(__file__).with_name(TEMPLATE_NAME)
        try:
            template = path.read_text(encoding="utf-8")
        except OSError as error:
            raise RenderError(f"cannot read template {path}: {error}") from error

    body = MarkdownRenderer().render("\n".join(lines))
    document = (
        template.replace("{{TITLE}}", escape_attr(resolved_title))
        .replace("{{EYEBROW}}", escape_attr(resolved_eyebrow))
        .replace("{{DATE}}", escape_attr(resolved_date))
        .replace("{{BODY}}", body)
    )
    return document


def render_file(
    input_path: Path,
    outdir: Path,
    *,
    title: str | None = None,
    eyebrow: str | None = None,
    date: str | None = None,
    template_path: Path | None = None,
) -> Path:
    """Render ``input_path`` to ``outdir/index.html`` and return that path."""
    try:
        source = input_path.read_text(encoding="utf-8")
    except OSError as error:
        raise RenderError(f"cannot read {input_path}: {error}") from error
    except UnicodeDecodeError as error:
        raise RenderError(f"{input_path} is not UTF-8 text: {error}") from error
    try:
        modified = datetime.fromtimestamp(input_path.stat().st_mtime)
    except OSError:
        modified = datetime.now()
    document = render_document(
        source,
        title=title,
        eyebrow=eyebrow,
        date=date,
        fallback_title=input_path.stem,
        fallback_date=modified,
        template_path=template_path,
    )
    outdir.mkdir(parents=True, exist_ok=True)
    target = outdir / "index.html"
    try:
        target.write_text(document, encoding="utf-8")
    except OSError as error:
        raise RenderError(f"cannot write {target}: {error}") from error
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Render a Markdown report to a styled HTML page.",
    )
    parser.add_argument("input", type=Path, help="Markdown file to render")
    parser.add_argument("outdir", type=Path, help="directory for index.html")
    parser.add_argument("--title", help="document title (default: first H1 or file name)")
    parser.add_argument("--eyebrow", help="small label above the title")
    parser.add_argument("--date", help="date line (default: file modification date)")
    parser.add_argument("--template", type=Path, help="alternate HTML template")
    args = parser.parse_args(argv)
    try:
        target = render_file(
            args.input,
            args.outdir,
            title=args.title,
            eyebrow=args.eyebrow,
            date=args.date,
            template_path=args.template,
        )
    except RenderError as error:
        print(f"render.py: {error}", file=sys.stderr)
        return 2
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
