import { describe, expect, it } from "vitest";
import { renderSafeMarkdown } from "./markdown.ts";

describe("renderSafeMarkdown", () => {
  it("renders headings, paragraphs, lists, and code deterministically", () => {
    const source = "# Title\n\nFirst\nsecond\n\n- alpha\n- beta\n\n```js\nconst x = 1;\n```";
    const rendered = renderSafeMarkdown(source);
    expect(rendered).toBe(renderSafeMarkdown(source));
    expect(rendered).toContain("<h1>Title</h1>");
    expect(rendered).toContain("<p>First\nsecond</p>");
    expect(rendered).toContain("<ul>\n<li>alpha</li>\n<li>beta</li>\n</ul>");
    expect(rendered).toContain("<pre><code>const x = 1;</code></pre>");
  });

  it("escapes raw HTML and leaves links and images as inert text", () => {
    const rendered = renderSafeMarkdown(
      '<img src="https://example.com/x" onerror="alert(1)"> [link](javascript:alert(1)) ![image](https://example.com/x)',
    );
    expect(rendered).toContain("&lt;img src=&quot;https://example.com/x&quot;");
    expect(rendered).toContain("[link](javascript:alert(1))");
    expect(rendered).toContain("![image](https://example.com/x)");
    expect(rendered).not.toMatch(/<(?:img|a)\b|href=/i);
  });

  it("does not interpret unsupported inline or MDX constructs", () => {
    expect(renderSafeMarkdown("<Component /> {process.env.SECRET}")).toBe(
      "<p>&lt;Component /&gt; {process.env.SECRET}</p>",
    );
  });
});
