package directory

import (
	"strconv"
	"strings"
	"testing"

	"gno.land/p/g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm/remixlab/core/v1"
	"gno.land/p/nt/testutils/v0"
	"gno.land/p/nt/uassert/v0"
)

var (
	owner    = testutils.TestAddress("owner")
	reviewer = testutils.TestAddress("reviewer")
	alice    = testutils.TestAddress("alice")
	mallory  = testutils.TestAddress("mallory")
)

func reset() {
	setup(owner)
}

func TestDirectoryAcceptance(cur realm, t *testing.T) {
	reset()

	// Submit a project.
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Submit(cross(cur), "Gno Boards", "gno.land/r/demo/boards", "Realm", "2023", "Message boards.\nWith replies.")

	// Reject invalid fields.
	cases := []struct {
		msg                                  string
		name, link, category, since, summary string
	}{
		{"remix: invalid input: name is required", "", "x", "Realm", "", ""},
		{"remix: invalid input: link is required", "x", "", "Realm", "", ""},
		{"remix: invalid input: category is not an allowed choice", "x", "y", "Scam", "", ""},
		{"remix: invalid input: since must be an integer", "x", "y", "Tool", "soon", ""},
		{"remix: invalid input: since out of range", "x", "y", "Tool", "1999", ""},
		{"remix: limit exceeded: name is too long", strings.Repeat("n", 81), "y", "Tool", "", ""},
		{"remix: invalid input: name contains control characters", "two\nlines", "y", "Tool", "", ""},
	}
	for _, c := range cases {
		uassert.AbortsWithMessage(t, cur, c.msg, func() {
			Submit(cross(cur), c.name, c.link, c.category, c.since, c.summary)
		})
	}
	uassert.Equal(t, 1, len(Queue(0, 25)))

	// Approve it.
	testing.SetRealm(testing.NewUserRealm(owner))
	Accept(cross(cur), id)
	list := Entries(0, 25)
	uassert.Equal(t, 1, len(list))
	uassert.Equal(t, "Gno Boards", list[0].Answers[0])
	uassert.Equal(t, alice, list[0].Submitter)
	page := Render("entries/1")
	uassert.True(t, strings.Contains(page, "Status: **accepted**"), page)
	uassert.True(t, strings.Contains(page, `Message boards\. With replies\.`), page)

	// Paginate entries.
	for i := 0; i < 30; i++ {
		testing.SetRealm(testing.NewUserRealm(testutils.TestAddress("sub" + strconv.Itoa(i/3))))
		n := Submit(cross(cur), "Entry "+strconv.Itoa(i), "x", "Tool", "", "")
		testing.SetRealm(testing.NewUserRealm(owner))
		Accept(cross(cur), n)
	}
	uassert.Equal(t, 25, len(Entries(0, 25)))
	uassert.Equal(t, 6, len(Entries(25, 25)))
	uassert.Equal(t, 25, len(Entries(0, 1000))) // limits are clamped
	page2 := Render("entries?page=2")
	uassert.True(t, strings.Contains(page2, "Entry 29"), page2)
	uassert.False(t, strings.Contains(page2, "Entry 0 "), page2)
	uassert.True(t, strings.Contains(page2, "page 2 of 2"), page2)
}

func TestIntegerAnswersAreNormalized(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Submit(cross(cur), "x", "y", "Tool", "02024", "")
	v, _ := Entry(id)
	uassert.Equal(t, "2024", v.Answers[3])
}

func TestSubmissionLimits(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	for i := 0; i < 3; i++ {
		Submit(cross(cur), "x", "y", "Tool", "", "")
	}
	uassert.AbortsWithMessage(t, cur, "remix: limit exceeded: submission limit reached for this address", func() {
		Submit(cross(cur), "x", "y", "Tool", "", "")
	})
	// Other addresses are unaffected.
	testing.SetRealm(testing.NewUserRealm(mallory))
	Submit(cross(cur), "x", "y", "Tool", "", "")
}

func TestOnlyReviewersReview(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	Invite(cross(cur), reviewer, "reviewer")
	Invite(cross(cur), alice, "member")
	testing.SetRealm(testing.NewUserRealm(reviewer))
	Join(cross(cur))
	testing.SetRealm(testing.NewUserRealm(alice))
	Join(cross(cur))
	a := Submit(cross(cur), "a", "y", "Tool", "", "")
	b := Submit(cross(cur), "b", "y", "Tool", "", "")

	// A member, even the submitter, cannot review.
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: entry.review requires reviewer", func() {
		Accept(cross(cur), a)
	})

	testing.SetRealm(testing.NewUserRealm(reviewer))
	Accept(cross(cur), a)
	Reject(cross(cur), b)
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: submission already reviewed", func() {
		Accept(cross(cur), b)
	})
	uassert.AbortsWithMessage(t, cur, "remix: not found: submission", func() {
		Accept(cross(cur), 99)
	})

	// Reviewers cannot invite (the rule is "owner") or appoint owners.
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: members.invite requires owner", func() {
		Invite(cross(cur), mallory, "owner")
	})
}

func TestIntermediaryRealmGainsNoAuthority(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(alice))
	id := Submit(cross(cur), "a", "y", "Tool", "", "")

	// The owner signs, but a realm in between is the caller.
	testing.SetOriginCaller(owner)
	testing.SetRealm(testing.NewCodeRealm("gno.land/r/evil/proxy"))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: entry.review requires reviewer", func() {
		Accept(cross(cur), id)
	})
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: policy.set requires owner", func() {
		SetRule(cross(cur), "entry.review", "owner")
	})

	// With a public submit rule the realm may submit, but as itself.
	pid := Submit(cross(cur), "b", "y", "Tool", "", "")
	v, _ := Entry(pid)
	uassert.NotEqual(t, owner, v.Submitter)
}

func TestRejectedEntriesAreNotListed(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(mallory))
	id := Submit(cross(cur), "Buy tokens now", "y", "Other", "", "spam")
	testing.SetRealm(testing.NewUserRealm(owner))
	Reject(cross(cur), id)

	uassert.Equal(t, 0, len(Entries(0, 25)))
	uassert.Equal(t, 0, len(Queue(0, 25)))
	page := Render("entries/1")
	uassert.True(t, strings.Contains(page, "This entry was rejected."), page)
	uassert.False(t, strings.Contains(page, "Buy tokens"), page)
	uassert.False(t, strings.Contains(Render(""), "Buy tokens"))

	// The data stays readable: submissions are public chain data.
	v, ok := Entry(id)
	uassert.True(t, ok)
	uassert.Equal(t, int(core.SubmissionRejected), int(v.Status))
}

func TestPolicyFloors(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(owner))
	uassert.AbortsWithMessage(t, cur, "remix: invalid input: entry.review: rule below floor reviewer", func() {
		SetRule(cross(cur), "entry.review", "member")
	})

	// Restricting submissions to members locks out outsiders.
	SetRule(cross(cur), "entry.submit", "member")
	testing.SetRealm(testing.NewUserRealm(mallory))
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: entry.submit requires member", func() {
		Submit(cross(cur), "a", "y", "Tool", "", "")
	})

	// Closing submissions entirely is allowed.
	testing.SetRealm(testing.NewUserRealm(owner))
	SetRule(cross(cur), "entry.submit", "nobody")
	uassert.AbortsWithMessage(t, cur, "remix: unauthorized: entry.submit requires nobody", func() {
		Submit(cross(cur), "a", "y", "Tool", "", "")
	})
}

func TestRenderEscapesSubmittedText(cur realm, t *testing.T) {
	reset()
	testing.SetRealm(testing.NewUserRealm(mallory))
	id := Submit(cross(cur),
		"[click](https://evil.example) <script>",
		"/r/x$help&func=Drain",
		"Tool", "", "![img](https://evil.example/x.png)\n# Heading")
	testing.SetRealm(testing.NewUserRealm(owner))
	Accept(cross(cur), id)

	for _, path := range []string{"", "entries", "entries/1", "queue"} {
		page := Render(path)
		uassert.False(t, strings.Contains(page, "](https://evil"), path)
		uassert.False(t, strings.Contains(page, "<script>"), path)
		uassert.False(t, strings.Contains(page, "\n# Heading"), path)
		uassert.False(t, strings.Contains(page, "$help&func=Drain"), path)
	}
	uassert.True(t, strings.Contains(Render("entries/1"), `\[click\]\(https\:\/\/evil\.example\) &lt;script&gt;`))
}

func TestUninitializedRealmRejectsWrites(cur realm, t *testing.T) {
	members, policy, entries = nil, nil, nil
	testing.SetRealm(testing.NewUserRealm(alice))
	uassert.AbortsWithMessage(t, cur, "remix: invalid state: app is not initialized", func() {
		Submit(cross(cur), "a", "y", "Tool", "", "")
	})
	uassert.True(t, strings.Contains(Render(""), "not initialized"))
}
