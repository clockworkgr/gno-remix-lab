// Package render is the Remix Lab rendering block: escaping for untrusted
// text, Markdown tables, paginated lists, route parsing and gnoweb
// transaction links.
//
// Every string that came from a user must pass through Text or Paragraph
// before it reaches Markdown. Escaped output cannot open links, images,
// HTML, headings, tables, code spans or bare URLs.
package render

import (
	"net/url"
	"strconv"
	"strings"
)

// Text escapes s for inline Markdown. Newlines and control characters become
// spaces; every ASCII punctuation character Markdown or gnoweb could
// interpret is backslash-escaped, and "<", ">" and "&" become entities.
func Text(s string) string {
	var sb strings.Builder
	for _, r := range s {
		switch {
		case r == '<':
			sb.WriteString("&lt;")
		case r == '>':
			sb.WriteString("&gt;")
		case r == '&':
			sb.WriteString("&amp;")
		case r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) || r == 0x2028 || r == 0x2029:
			sb.WriteByte(' ')
		case r < 0x80 && isMarkdownPunct(byte(r)):
			sb.WriteByte('\\')
			sb.WriteRune(r)
		default:
			sb.WriteRune(r)
		}
	}
	return sb.String()
}

// Paragraph escapes multi-line text, keeping line breaks as hard breaks.
func Paragraph(s string) string {
	lines := strings.Split(s, "\n")
	for i, l := range lines {
		lines[i] = Text(l)
	}
	return strings.Join(lines, "  \n")
}

// Code renders s as an inline code span that cannot be closed early.
func Code(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	fence := "`"
	for strings.Contains(s, fence) {
		fence += "`"
	}
	return fence + " " + s + " " + fence
}

func isMarkdownPunct(c byte) bool {
	return strings.IndexByte("\\`*_{}[]()#+-.!|~:\"'=$%^/", c) >= 0
}

// Heading returns a Markdown heading with escaped text. level is clamped to
// 1..6.
func Heading(level int, text string) string {
	if level < 1 {
		level = 1
	}
	if level > 6 {
		level = 6
	}
	return strings.Repeat("#", level) + " " + Text(text) + "\n\n"
}

// Table renders a Markdown table. Every header and cell is escaped. Rows
// shorter than the header are padded; longer rows are truncated.
func Table(headers []string, rows [][]string) string {
	if len(headers) == 0 {
		return ""
	}
	var sb strings.Builder
	sb.WriteString("|")
	for _, h := range headers {
		sb.WriteString(" " + Text(h) + " |")
	}
	sb.WriteString("\n|")
	for range headers {
		sb.WriteString(" --- |")
	}
	sb.WriteString("\n")
	for _, row := range rows {
		sb.WriteString("|")
		for i := range headers {
			cell := ""
			if i < len(row) {
				cell = row[i]
			}
			sb.WriteString(" " + cell + " |")
		}
		sb.WriteString("\n")
	}
	return sb.String() + "\n"
}

// TrustedRow marks a row whose cells were already built from escaped text
// and trusted markup (for example links from Link or TxLink). Use Row for
// untrusted cells.
func TrustedRow(cells ...string) []string { return cells }

// Row escapes every cell.
func Row(cells ...string) []string {
	out := make([]string, len(cells))
	for i, c := range cells {
		out[i] = Text(c)
	}
	return out
}

// Link renders a link with an escaped label to a realm-relative target,
// e.g. "/r/foo/bar:polls/3". External or scheme-bearing targets are refused
// and rendered as plain escaped text.
func Link(label, target string) string {
	if !isRelativeRealmTarget(target) {
		return Text(label)
	}
	return "[" + Text(label) + "](" + target + ")"
}

// RealmURL turns a package path into the realm-relative URL gnoweb serves,
// optionally with a render path: RealmURL("gno.land/r/a/b", "polls/1") ->
// "/r/a/b:polls/1".
func RealmURL(pkgPath, renderPath string) string {
	base, ok := relativeRealm(pkgPath)
	if !ok {
		return ""
	}
	if renderPath == "" {
		return base
	}
	return base + ":" + escapePath(renderPath)
}

// TxLink renders a gnoweb transaction link for fn on the realm at pkgPath
// with the given key/value arguments. Function and key names must be Go
// identifiers; values are URL-encoded. Invalid input renders the label as
// plain text so a bad link never reaches the page.
func TxLink(label, pkgPath, fn string, kv ...string) string {
	u := TxURL(pkgPath, fn, kv...)
	if u == "" {
		return Text(label)
	}
	return "[" + Text(label) + "](" + u + ")"
}

// TxURL builds the gnoweb "$help" URL used by TxLink, or "" when the input
// is invalid.
func TxURL(pkgPath, fn string, kv ...string) string {
	base, ok := relativeRealm(pkgPath)
	if !ok || !isIdent(fn) || len(kv)%2 != 0 {
		return ""
	}
	u := base + "$help&func=" + fn
	for i := 0; i < len(kv); i += 2 {
		if !isIdent(kv[i]) {
			return ""
		}
		u += "&" + kv[i] + "=" + url.QueryEscape(kv[i+1])
	}
	return u
}

// ParsePath splits a render path such as "polls/3?page=2" into its route
// segments and query values. Malformed queries yield empty values.
func ParsePath(path string) ([]string, url.Values) {
	route, rawQuery := path, ""
	if i := strings.IndexByte(path, '?'); i >= 0 {
		route, rawQuery = path[:i], path[i+1:]
	}
	var segs []string
	for _, s := range strings.Split(route, "/") {
		if s != "" {
			segs = append(segs, s)
		}
	}
	q, err := url.ParseQuery(rawQuery)
	if err != nil {
		q = url.Values{}
	}
	return segs, q
}

// Page reads a 1-based "page" query value, clamped to 1..maxPage.
func Page(q url.Values, maxPage int) int {
	p, err := strconv.Atoi(q.Get("page"))
	if err != nil || p < 1 {
		return 1
	}
	if maxPage >= 1 && p > maxPage {
		return maxPage
	}
	return p
}

// PageCount returns the number of pages needed for total items.
func PageCount(total, pageSize int) int {
	if total <= 0 || pageSize <= 0 {
		return 1
	}
	return (total + pageSize - 1) / pageSize
}

// Pager renders previous/next links for a paginated route under pkgPath.
func Pager(pkgPath, route string, page, pages int) string {
	if pages <= 1 {
		return ""
	}
	var parts []string
	if page > 1 {
		parts = append(parts, Link("← previous", RealmURL(pkgPath, route+"?page="+strconv.Itoa(page-1))))
	}
	parts = append(parts, "page "+strconv.Itoa(page)+" of "+strconv.Itoa(pages))
	if page < pages {
		parts = append(parts, Link("next →", RealmURL(pkgPath, route+"?page="+strconv.Itoa(page+1))))
	}
	return strings.Join(parts, " · ") + "\n\n"
}

func relativeRealm(pkgPath string) (string, bool) {
	const prefix = "gno.land/r/"
	if !strings.HasPrefix(pkgPath, prefix) || len(pkgPath) == len(prefix) {
		return "", false
	}
	rest := pkgPath[len("gno.land"):]
	for _, c := range rest {
		lower := c >= 'a' && c <= 'z'
		digit := c >= '0' && c <= '9'
		if !(lower || digit || c == '/' || c == '_') {
			return "", false
		}
	}
	return rest, true
}

func isRelativeRealmTarget(t string) bool {
	if !strings.HasPrefix(t, "/r/") && !strings.HasPrefix(t, "/p/") {
		return false
	}
	for _, c := range t {
		if c <= ' ' || c == '(' || c == ')' || c == '<' || c == '>' || c == '"' || c == '\\' || c == '`' {
			return false
		}
	}
	return !strings.Contains(t, "//")
}

// escapePath keeps a render path safe inside a Markdown link target.
func escapePath(p string) string {
	var sb strings.Builder
	for i := 0; i < len(p); i++ {
		c := p[i]
		safe := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			strings.IndexByte("/-_.?=&:", c) >= 0
		if safe {
			sb.WriteByte(c)
		} else {
			sb.WriteString("%" + strings.ToUpper(strconv.FormatInt(int64(c)>>4, 16)) + strings.ToUpper(strconv.FormatInt(int64(c)&15, 16)))
		}
	}
	return sb.String()
}

func isIdent(s string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for i, c := range s {
		letter := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_'
		digit := c >= '0' && c <= '9'
		if !(letter || (i > 0 && digit)) {
			return false
		}
	}
	return true
}
