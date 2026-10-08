package render

import (
	"strings"
	"testing"
)

func TestTextNeutralizesMarkup(t *testing.T) {
	hostile := []string{
		"[click](https://evil.example)",
		"![img](x.png)",
		"<script>alert(1)</script>",
		"# heading",
		"`code`",
		"| a | b |",
		"https://evil.example/path",
		"line1\nline2\r\n# h",
		"/r/foo$help&func=Drain&to=g1x",
		"\x1b[31mred",
		"\\[x](/r/evil)",
		"hi @alice",
	}
	for _, h := range hostile {
		out := Text(h)
		for _, bad := range []string{"<", ">", "\n", "\r", "](", "://", "\x1b"} {
			if strings.Contains(out, bad) {
				t.Errorf("Text(%q) = %q still contains %q", h, out, bad)
			}
		}
		for i := 0; i < len(out); i++ {
			c := out[i]
			if strings.IndexByte("[]()`|#!@", c) >= 0 && !escapedAt(out, i) {
				t.Errorf("Text(%q) = %q has unescaped %q", h, out, string(c))
			}
		}
	}
	if Text("héllo wörld") != "héllo wörld" {
		t.Error("plain unicode text altered")
	}
	if got := Text("a\u202eb\u200bc\u2066d\ufeff\u00ad"); got != "abcd" {
		t.Errorf("format characters kept: %q", got)
	}
	if got := Text("👨\u200d👩"); got != "👨\u200d👩" {
		t.Errorf("ZWJ sequence altered: %q", got)
	}
}

// escapedAt reports whether out[i] is preceded by an odd number of
// backslashes.
func escapedAt(out string, i int) bool {
	n := 0
	for j := i - 1; j >= 0 && out[j] == '\\'; j-- {
		n++
	}
	return n%2 == 1
}

func TestParagraphKeepsBreaks(t *testing.T) {
	got := Paragraph("a\n*b*")
	if got != "a  \n\\*b\\*" {
		t.Fatalf("got %q", got)
	}
	if got := Paragraph("    code\n\n\tmore"); got != "code  \n  \nmore" {
		t.Fatalf("indented lines kept: %q", got)
	}
}

func TestCode(t *testing.T) {
	if Code("a`b") != "`` a`b ``" {
		t.Fatal(Code("a`b"))
	}
	if got := Code("a|b\u2028c\u202ed"); got != "` a¦b cd `" {
		t.Fatalf("got %q", got)
	}
}

func TestLinks(t *testing.T) {
	if got := Link("x", "/r/demo/app:polls/1"); got != "[x](/r/demo/app:polls/1)" {
		t.Fatal(got)
	}
	for _, bad := range []string{"https://evil", "javascript:alert(1)", "//evil.example", "/r/a) [x](https://e", "/r/a b"} {
		if got := Link("x", bad); got != "x" {
			t.Errorf("Link accepted %q: %s", bad, got)
		}
	}
	if RealmURL("gno.land/r/demo/app", "polls/1?page=2") != "/r/demo/app:polls/1?page=2" {
		t.Fatal(RealmURL("gno.land/r/demo/app", "polls/1?page=2"))
	}
	if RealmURL("gno.land/r/demo/app", "a b(c)") != "/r/demo/app:a%20b%28c%29" {
		t.Fatal(RealmURL("gno.land/r/demo/app", "a b(c)"))
	}
	if RealmURL("gno.land/p/demo/x", "") != "" || RealmURL("evil.com/r/x", "") != "" {
		t.Fatal("non-realm path accepted")
	}
	if RealmURL("gno.land/r/foo/my-app", "x") != "/r/foo/my-app:x" {
		t.Fatal("hyphenated realm rejected")
	}
	for _, bad := range []string{"gno.land/r/", "gno.land/r//x", "gno.land/r/x/", "gno.land/r/X", "gno.land/r/a.b"} {
		if RealmURL(bad, "") != "" {
			t.Errorf("accepted %q", bad)
		}
	}
	got := RealmQueryURL("gno.land/r/demo/app", "search", "q", "a&b c", "page", "2")
	if got != "/r/demo/app:search?q=a%26b+c&page=2" {
		t.Fatal(got)
	}
	_, q := ParsePath(got[len("/r/demo/app:"):])
	if q.Get("q") != "a&b c" || q.Get("page") != "2" {
		t.Fatal("query value did not round-trip")
	}
	if RealmQueryURL("gno.land/r/demo/app", "", "page", "2") != "/r/demo/app:?page=2" {
		t.Fatal(RealmQueryURL("gno.land/r/demo/app", "", "page", "2"))
	}
	if RealmQueryURL("gno.land/r/demo/app", "x?y=1", "a", "b") != "" || RealmQueryURL("gno.land/r/demo/app", "x", "bad key", "b") != "" {
		t.Fatal("invalid query accepted")
	}
}

func TestTxURL(t *testing.T) {
	got := TxURL("gno.land/r/demo/app", "Vote", "id", "3", "choice", "a&func=Drain")
	want := "/r/demo/app$help&func=Vote&id=3&choice=a%26func%3DDrain"
	if got != want {
		t.Fatalf("got %s", got)
	}
	if TxURL("gno.land/r/demo/app", "Vote&x=1") != "" {
		t.Fatal("bad func accepted")
	}
	if TxURL("gno.land/r/demo/app", "Vote", "bad key", "1") != "" {
		t.Fatal("bad key accepted")
	}
	if TxURL("gno.land/r/demo/app", "Vote", "odd") != "" {
		t.Fatal("odd args accepted")
	}
	if TxLink("Vote [now]", "https://x", "Vote") != "Vote \\[now\\]" {
		t.Fatal("invalid tx link should degrade to text")
	}
}

func TestTable(t *testing.T) {
	out := Table([]string{"Name", "Votes"}, [][]string{Row("a|b", "1"), Row("c")})
	want := "| Name | Votes |\n| --- | --- |\n| a\\|b | 1 |\n| c |  |\n\n"
	if out != want {
		t.Fatalf("got %q", out)
	}
	// Trusted cells still cannot split the row or end the table.
	out = Table([]string{"h"}, [][]string{TrustedRow("x | y\n# h", "a\\\\|b", "c\\|d")})
	want = "| h |\n| --- |\n| x \\| y # h |\n\n"
	if out != want {
		t.Fatalf("got %q", out)
	}
	if got := tableCell("a\\\\|b"); got != "a\\\\\\|b" {
		t.Fatalf("got %q", got)
	}
	if got := tableCell("c\\|d"); got != "c\\|d" {
		t.Fatalf("got %q", got)
	}
}

func TestParsePathAndPaging(t *testing.T) {
	segs, q := ParsePath("polls/3?page=2")
	if len(segs) != 2 || segs[0] != "polls" || segs[1] != "3" || Page(q, 5) != 2 {
		t.Fatal("parse")
	}
	_, q = ParsePath("x?page=99")
	if Page(q, 4) != 4 {
		t.Fatal("clamp high")
	}
	_, q = ParsePath("x?page=-3")
	if Page(q, 4) != 1 {
		t.Fatal("clamp low")
	}
	segs, _ = ParsePath("")
	if len(segs) != 0 {
		t.Fatal("empty path")
	}
	if PageCount(0, 25) != 1 || PageCount(26, 25) != 2 || PageCount(25, 25) != 1 {
		t.Fatal("page count")
	}
	if Pager("gno.land/r/a/b", "polls", 1, 1) != "" {
		t.Fatal("single page pager")
	}
	p := Pager("gno.land/r/a/b", "polls", 2, 3)
	if !strings.Contains(p, "(/r/a/b:polls?page=1)") || !strings.Contains(p, "(/r/a/b:polls?page=3)") {
		t.Fatal(p)
	}
	p = Pager("gno.land/r/a/b", "polls", 9, 3)
	if !strings.Contains(p, "page 3 of 3") || strings.Contains(p, "next") {
		t.Fatal(p)
	}
	_, q = ParsePath("x?page=5")
	if Page(q, 0) != 1 {
		t.Fatal("maxPage below 1")
	}
}
