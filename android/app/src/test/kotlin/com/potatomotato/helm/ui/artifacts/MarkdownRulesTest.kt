package com.potatomotato.helm.ui.artifacts

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The limited markdown the artifact detail screen renders.
 *
 * The phone renders a DELIBERATE SUBSET — the structure an artifact author uses
 * when writing for a reader (headings, emphasis, code, lists, quotes, rules,
 * links) — and it must never grow a second full markdown engine: the desktop
 * renders artifacts in full, and everything here is the phone-width read-back.
 * The parser is pure Kotlin and the tests pin both what it recognises and what
 * it deliberately leaves as literal text.
 */
class MarkdownRulesTest {

    @Test
    fun `a bare url in a paragraph becomes a link`() {
        assertEquals(
            listOf(
                MdBlock.Paragraph(
                    listOf(
                        MdSpan.Text("see "),
                        MdSpan.Link("https://example.com/a", "https://example.com/a"),
                        MdSpan.Text(" now"),
                    ),
                ),
            ),
            MarkdownRules.blocks("see https://example.com/a now"),
        )
    }

    @Test
    fun `an explicit link still wins over the bare form`() {
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(MdSpan.Link("docs", "https://example.com")))),
            MarkdownRules.blocks("[docs](https://example.com)"),
        )
    }

    @Test
    fun `a url inside a code span stays code`() {
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(MdSpan.CodeSpan("https://example.com")))),
            MarkdownRules.blocks("`https://example.com`"),
        )
    }

    @Test
    fun `a word merely starting with h is ordinary text`() {
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(MdSpan.Text("however http is a scheme")))),
            MarkdownRules.blocks("however http is a scheme"),
        )
    }

    @Test
    fun `linksOnly finds the url and leaves the markers literal`() {
        assertEquals(
            listOf(
                MdSpan.Text("**not bold** "),
                MdSpan.Link("https://example.com", "https://example.com"),
                MdSpan.Text(" ok"),
            ),
            MarkdownRules.linksOnly("**not bold** https://example.com ok"),
        )
    }

    @Test
    fun `linksOnly on text with no url is one plain span`() {
        assertEquals(listOf(MdSpan.Text("just words")), MarkdownRules.linksOnly("just words"))
    }

    @Test
    fun `linksOnly on empty text is nothing at all`() {
        assertEquals(emptyList<MdSpan>(), MarkdownRules.linksOnly(""))
    }

    @Test
    fun `an ATX heading carries its level`() {
        assertEquals(
            listOf(MdBlock.Heading(1, "Report"), MdBlock.Heading(3, "Timings")),
            MarkdownRules.blocks("# Report\n\n### Timings"),
        )
    }

    @Test
    fun `seven hashes are not a heading`() {
        // ATX headings stop at six; past that it is a paragraph that happens to
        // start with hashes.
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(MdSpan.Text("####### seven")))),
            MarkdownRules.blocks("####### seven"),
        )
    }

    @Test
    fun `a paragraph keeps its soft breaks as spaces`() {
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(MdSpan.Text("first second third")))),
            MarkdownRules.blocks("first\nsecond\nthird"),
        )
    }

    @Test
    fun `a blank line separates paragraphs`() {
        val blocks = MarkdownRules.blocks("one\n\ntwo")

        assertEquals(2, blocks.size)
        assertEquals("one", (blocks[0] as MdBlock.Paragraph).spans.single().let { (it as MdSpan.Text).text })
        assertEquals("two", (blocks[1] as MdBlock.Paragraph).spans.single().let { (it as MdSpan.Text).text })
    }

    @Test
    fun `bold italic and code are recognised inline`() {
        val spans = (MarkdownRules.blocks("a **bold** and *soft* and `tick` day")
            .single() as MdBlock.Paragraph).spans

        assertEquals(
            listOf(
                MdSpan.Text("a "),
                MdSpan.Bold("bold"),
                MdSpan.Text(" and "),
                MdSpan.Italic("soft"),
                MdSpan.Text(" and "),
                MdSpan.CodeSpan("tick"),
                MdSpan.Text(" day"),
            ),
            spans,
        )
    }

    @Test
    fun `a link keeps its text and drops its target into the span`() {
        val spans = (MarkdownRules.blocks("see [the docs](https://example.com/x) first")
            .single() as MdBlock.Paragraph).spans

        assertEquals(
            listOf(MdSpan.Text("see "), MdSpan.Link("the docs", "https://example.com/x"), MdSpan.Text(" first")),
            spans,
        )
    }

    @Test
    fun `unterminated markers stay literal text`() {
        val spans = (MarkdownRules.blocks("2 * 3 = 6 and an [unclosed link")
            .single() as MdBlock.Paragraph).spans

        assertEquals(listOf(MdSpan.Text("2 * 3 = 6 and an [unclosed link")), spans)
    }

    @Test
    fun `a fenced code block keeps ordinary lines plain`() {
        // No inline parsing inside a fence: code remains code, not markdown.
        assertEquals(
            listOf(MdBlock.Code(listOf(MdCodeLine("val x = **not bold**", 0), MdCodeLine("keep `this`", 0)))),
            MarkdownRules.blocks("```\nval x = **not bold**\nkeep `this`\n```"),
        )
    }

    @Test
    fun `code lines at the render limit remain complete`() {
        val line = "x".repeat(4_096)

        assertEquals(
            listOf(MdBlock.Code(listOf(MdCodeLine(line, 0)))),
            MarkdownRules.blocks("```\n$line\n```"),
        )
    }

    @Test
    fun `code lines over the render limit keep a short preview and exact omitted count`() {
        val line = "x".repeat(4_097)

        assertEquals(
            listOf(MdBlock.Code(listOf(MdCodeLine("x".repeat(256), 3_841)))),
            MarkdownRules.blocks("```\n$line\n```"),
        )
    }

    @Test
    fun `the reported artifact line is bounded before rendering`() {
        val line = "x".repeat(496_386)
        val rendered = (MarkdownRules.blocks("```\n$line\n```").single() as MdBlock.Code).lines.single()

        assertEquals("x".repeat(256), rendered.text)
        assertEquals(496_130, rendered.omittedCharacters)
    }

    @Test
    fun `an unclosed fence runs to the end of the body`() {
        assertEquals(
            listOf(MdBlock.Code(listOf(MdCodeLine("still code", 0)))),
            MarkdownRules.blocks("```\nstill code"),
        )
    }

    @Test
    fun `a mermaid fence becomes a diagram carrying its source`() {
        assertEquals(
            listOf(MdBlock.Diagram("flowchart TD\n  A --> B")),
            MarkdownRules.blocks("```mermaid\nflowchart TD\n  A --> B\n```"),
        )
    }

    @Test
    fun `an unclosed mermaid fence still becomes a diagram`() {
        assertEquals(
            listOf(MdBlock.Diagram("graph LR")),
            MarkdownRules.blocks("```mermaid\ngraph LR"),
        )
    }

    @Test
    fun `the fence's first info word decides — decorations after it are ignored`() {
        // ```mermaid title: the desktop reads the FIRST word as the language.
        assertEquals(
            listOf(MdBlock.Diagram("graph TD")),
            MarkdownRules.blocks("```mermaid title\ngraph TD\n```"),
        )
    }

    @Test
    fun `a fence naming another language stays code`() {
        assertEquals(
            listOf(MdBlock.Code(listOf(MdCodeLine("println()", 0)))),
            MarkdownRules.blocks("```kotlin\nprintln()\n```"),
        )
    }

    @Test
    fun `bullets and quotes become their own blocks`() {
        assertEquals(
            listOf(
                MdBlock.Bullet(listOf(MdSpan.Text("first"))),
                MdBlock.Bullet(listOf(MdSpan.Text("second"))),
                MdBlock.Quote(listOf(MdSpan.Text("a note"))),
            ),
            MarkdownRules.blocks("- first\n* second\n> a note"),
        )
    }

    @Test
    fun `a horizontal rule is a rule`() {
        assertEquals(listOf(MdBlock.Rule, MdBlock.Rule), MarkdownRules.blocks("---\n\n*****"))
    }

    @Test
    fun `an empty body renders as nothing`() {
        assertEquals(emptyList<MdBlock>(), MarkdownRules.blocks(""))
        assertEquals(emptyList<MdBlock>(), MarkdownRules.blocks("\n\n"))
    }

    @Test
    fun `a mixed document keeps its order`() {
        val blocks = MarkdownRules.blocks(
            "# Title\n\nIntro with `code`.\n\n- item\n\n```\ncode\n```\n\n> quote\n\n---",
        )

        assertEquals(
            listOf(
                MdBlock.Heading(1, "Title"),
                MdBlock.Paragraph(listOf(MdSpan.Text("Intro with "), MdSpan.CodeSpan("code"), MdSpan.Text("."))),
                MdBlock.Bullet(listOf(MdSpan.Text("item"))),
                MdBlock.Code(listOf(MdCodeLine("code", 0))),
                MdBlock.Quote(listOf(MdSpan.Text("quote"))),
                MdBlock.Rule,
            ),
            blocks,
        )
    }

    // ---- GFM tables --------------------------------------------------------

    private fun cell(text: String) = listOf(MdSpan.Text(text))

    @Test
    fun `a header, separator and rows become one table`() {
        assertEquals(
            listOf(
                MdBlock.Table(
                    header = listOf(cell("Model"), cell("Ctx")),
                    align = listOf(MdAlign.Start, MdAlign.Start),
                    rows = listOf(listOf(cell("minicpm"), cell("131k"))),
                ),
            ),
            MarkdownRules.blocks("| Model | Ctx |\n|---|---|\n| minicpm | 131k |"),
        )
    }

    @Test
    fun `separator colons set column alignment`() {
        val table = MarkdownRules.blocks("a | b | c\n:-- | :-: | --:\n1 | 2 | 3").single() as MdBlock.Table
        assertEquals(listOf(MdAlign.Start, MdAlign.Center, MdAlign.End), table.align)
    }

    @Test
    fun `pipe lines without a separator stay a paragraph`() {
        assertEquals(
            listOf(MdBlock.Paragraph(listOf(MdSpan.Text("| a | b | | c | d |")))),
            MarkdownRules.blocks("| a | b |\n| c | d |"),
        )
    }

    @Test
    fun `short rows are padded and long rows trimmed to the header width`() {
        val table = MarkdownRules.blocks("| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |").single() as MdBlock.Table
        assertEquals(listOf(listOf(cell("1"), emptyList()), listOf(cell("1"), cell("2"))), table.rows)
    }

    @Test
    fun `an escaped pipe stays inside its cell`() {
        val table = MarkdownRules.blocks("| expr |\n|---|\n| a \\| b |").single() as MdBlock.Table
        assertEquals(listOf(listOf(cell("a | b"))), table.rows)
    }

    @Test
    fun `cells carry inline spans`() {
        val table = MarkdownRules.blocks("| k | v |\n|---|---|\n| **bold** | `code` |").single() as MdBlock.Table
        assertEquals(listOf(listOf(listOf(MdSpan.Bold("bold")), listOf(MdSpan.CodeSpan("code")))), table.rows)
    }

    @Test
    fun `a table ends at the first line without a pipe`() {
        val blocks = MarkdownRules.blocks("| a |\n|---|\n| 1 |\nafter")
        assertEquals(2, blocks.size)
        assertEquals(MdBlock.Paragraph(listOf(MdSpan.Text("after"))), blocks.last())
    }
}
