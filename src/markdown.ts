/** Render the deliberately small, non-executable Markdown subset used for notes. */
export function renderSafeMarkdown(source: string): string {
  const escape = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: "ul" | "ol" | undefined;
  let code: string[] | undefined;
  const flushParagraph = () => {
    if (paragraph.length) output.push(`<p>${paragraph.map(escape).join("\n")}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (list) output.push(`</${list}>`);
    list = undefined;
  };

  for (const line of lines) {
    if (code) {
      if (/^\s*```\s*$/.test(line)) {
        output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
        code = undefined;
      } else code.push(line);
      continue;
    }
    if (/^\s*```/.test(line)) {
      flushParagraph();
      flushList();
      code = [];
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    const item = /^\s*(?:([-+*])\s+|(\d+)\.\s+)(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      output.push(`<h${level}>${escape(heading[2])}</h${level}>`);
    } else if (item) {
      flushParagraph();
      const nextList = item[1] ? "ul" : "ol";
      if (list !== nextList) {
        flushList();
        list = nextList;
        output.push(`<${list}>`);
      }
      output.push(`<li>${escape(item[3])}</li>`);
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  if (code) output.push(`<pre><code>${escape(code.join("\n"))}</code></pre>`);
  flushParagraph();
  flushList();
  return output.join("\n");
}
