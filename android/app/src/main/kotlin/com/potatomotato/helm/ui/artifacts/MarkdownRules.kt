package com.potatomotato.helm.ui.artifacts

/**
 * The limited markdown the artifact detail screen renders, and the single place
 * that decides what that means.
 *
 * The phone renders a DELIBERATE SUBSET — the structure an artifact author uses
 * when writing for a reader: headings, emphasis, inline code, fenced code, lists,
 * quotes, rules and links — and deliberately nothing else. The desktop renders
 * artifacts in full fidelity; this is the phone-width read-back, and a second
 * complete markdown engine here could only drift from the first. Anything the
 * subset does not recognise stays literal text, which is why the parser can be
 * exhaustive about what it accepts and silent about everything else.
 *
 * Pure Kotlin and Android-free, like every other `*Rules` module: the block and
 * span decisions are the parts worth testing, and they test on the JVM.
 */
object MarkdownRules {

    /** Split a whole document into blocks. Never throws; never returns junk. */
    fun blocks(markdown: String): List<MdBlock> {
        val blocks = mutableListOf<MdBlock>()
        val paragraph = mutableListOf<String>()

        fun flushParagraph() {
            if (paragraph.isNotEmpty()) {
                blocks += MdBlock.Paragraph(spans(paragraph.joinToString(" ")))
                paragraph.clear()
            }
        }

        var index = 0
        val lines = markdown.lines()
        while (index < lines.size) {
            val line = lines[index]
            when {
                isFence(line) -> {
                    flushParagraph()
                    val body = mutableListOf<String>()
                    index++
                    while (index < lines.size && !isFence(lines[index])) {
                        body += lines[index]
                        index++
                    }
                    // An unclosed fence runs to the end of the body; the closing
                    // fence (if any) is consumed and never rendered.
                    blocks += MdBlock.Code(body)
                }

                line.isBlank() -> flushParagraph()

                isRule(line) -> {
                    flushParagraph()
                    blocks += MdBlock.Rule
                }

                isHeading(line) -> {
                    flushParagraph()
                    val level = line.takeWhile { it == '#' }.length
                    blocks += MdBlock.Heading(level, line.dropWhile { it == '#' }.trim())
                }

                isBullet(line) -> blocks += MdBlock.Bullet(spans(line.substring(2).trim()))

                isQuote(line) -> blocks += MdBlock.Quote(spans(line.substring(2).trim()))

                else -> paragraph += line.trim()
            }
            index++
        }
        flushParagraph()
        return blocks
    }

    /** Parse `**bold**`, `*italic*`, `` `code` `` and `[text](target)`, left to right. */
    private fun spans(text: String): List<MdSpan> {
        val out = mutableListOf<MdSpan>()
        val plain = StringBuilder()

        fun flush() {
            if (plain.isNotEmpty()) {
                out += MdSpan.Text(plain.toString())
                plain.clear()
            }
        }

        var i = 0
        while (i < text.length) {
            val rest = text.substring(i)
            val match = when {
                rest.startsWith(CODE_DELIM) -> matchDelimited(text, i + 1)
                rest.startsWith(BOLD_DELIM) -> matchMarker(text, i + 2, BOLD_DELIM)
                rest.startsWith(ITALIC_DELIM) -> matchMarker(text, i + 1, ITALIC_DELIM)
                rest.startsWith("[") -> matchLink(text, i)
                else -> null
            }
            if (match == null) {
                // Unterminated markers stay literal text — markdown's own rule
                // for a `*` that never finds its partner.
                plain.append(text[i])
                i++
            } else {
                flush()
                out += match.span
                i = match.end
            }
        }
        flush()
        return out
    }

    /** One recognised construct, and where the scanner resumes after it. */
    private data class Match(val span: MdSpan, val end: Int)

    private fun matchDelimited(text: String, from: Int): Match? {
        val close = text.indexOf('`', from)
        if (close <= from) return null
        return Match(MdSpan.CodeSpan(text.substring(from, close)), close + 1)
    }

    private fun matchMarker(text: String, from: Int, marker: String): Match? {
        val close = text.indexOf(marker, from)
        if (close <= from) return null
        val inner = text.substring(from, close)
        val span = if (marker == BOLD_DELIM) MdSpan.Bold(inner) else MdSpan.Italic(inner)
        return Match(span, close + marker.length)
    }

    private fun matchLink(text: String, from: Int): Match? {
        val body = text.indexOf("](", from)
        if (body <= from) return null
        val close = text.indexOf(')', body + 2)
        if (close <= body + 2) return null
        return Match(MdSpan.Link(text.substring(from + 1, body), text.substring(body + 2, close)), close + 1)
    }

    /** ``` or ~~~ — any fence marker, rendered the same. */
    private fun isFence(line: String): Boolean =
        line.trimStart().startsWith("```")

    private fun isHeading(line: String): Boolean =
        line.startsWith("#") && line.takeWhile { it == '#' }.length in 1..6 && isSpaceAfter(line, line.takeWhile { it == '#' }.length)

    private fun isRule(line: String): Boolean {
        val trimmed = line.trim()
        return trimmed.length >= 3 && (
            trimmed.all { it == '-' } ||
                trimmed.all { it == '*' } ||
                trimmed.all { it == '_' }
            )
    }

    private fun isBullet(line: String): Boolean =
        line.startsWith("- ") || line.startsWith("* ")

    private fun isQuote(line: String): Boolean = line.startsWith("> ")

    /** `#hashtag` is a paragraph; `# hash` is a heading. The space decides. */
    private fun isSpaceAfter(line: String, hashes: Int): Boolean =
        line.length == hashes || line[hashes] == ' '

    private const val CODE_DELIM = "`"
    private const val BOLD_DELIM = "**"
    private const val ITALIC_DELIM = "*"
}

/** One rendered chunk of the document, in reading order. */
sealed interface MdBlock {
    /** `#`..`######`. Seven hashes and up is a paragraph, per CommonMark. */
    data class Heading(val level: Int, val text: String) : MdBlock

    /** A paragraph of inline [spans]; soft line breaks render as spaces. */
    data class Paragraph(val spans: List<MdSpan>) : MdBlock

    /** A `- ` or `* ` list item, rendered as one row (no nesting). */
    data class Bullet(val spans: List<MdSpan>) : MdBlock

    /** A `> ` line, rendered as an indented row (no nesting). */
    data class Quote(val spans: List<MdSpan>) : MdBlock

    /** A fenced block; its lines are VERBATIM — no inline parsing inside. */
    data class Code(val lines: List<String>) : MdBlock

    /** A `---` / `***` / `___` rule. */
    data object Rule : MdBlock
}

/** One stretch of inline text within a block. */
sealed interface MdSpan {
    data class Text(val text: String) : MdSpan
    data class Bold(val text: String) : MdSpan
    data class Italic(val text: String) : MdSpan
    data class CodeSpan(val text: String) : MdSpan

    /**
     * A `[text](target)` link. The target is carried for the screen to style it
     * how it likes — a phone taps nothing off-link, so text wins.
     */
    data class Link(val text: String, val target: String) : MdSpan
}
