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
    fun `a fenced code block keeps its lines verbatim`() {
        // No inline parsing inside a fence: markdown's own rule, and the reason
        // code examples survive rendering intact.
        assertEquals(
            listOf(MdBlock.Code(listOf("val x = **not bold**", "keep `this`"))),
            MarkdownRules.blocks("```\nval x = **not bold**\nkeep `this`\n```"),
        )
    }

    @Test
    fun `an unclosed fence runs to the end of the body`() {
        assertEquals(
            listOf(MdBlock.Code(listOf("still code"))),
            MarkdownRules.blocks("```\nstill code"),
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
                MdBlock.Code(listOf("code")),
                MdBlock.Quote(listOf(MdSpan.Text("quote"))),
                MdBlock.Rule,
            ),
            blocks,
        )
    }
}
