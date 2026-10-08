package forms

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/remixlab/core/v1"
)

var (
	alice = testutils.TestAddress("alice")
	bob   = testutils.TestAddress("bob")
)

func projectFields() []Field {
	return []Field{
		{Name: "title", Label: "Project title", Kind: KindText, Required: true, MaxBytes: 60},
		{Name: "summary", Label: "Summary", Kind: KindText, MaxBytes: 200, Multiline: true},
		{Name: "year", Label: "Year started", Kind: KindInteger, Min: 2000, Max: 2100},
		{Name: "track", Label: "Track", Kind: KindChoice, Required: true, Choices: []string{"tooling", "apps", "docs"}},
	}
}

func newForm(cfg Config) *Form {
	return New(cfg, projectFields())
}

func defaultCfg() Config {
	return Config{MaxSubmissions: 100, MaxPerSubmitter: 2, MaxPayloadBytes: 1024}
}

func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err.Error())
	}
}

func mustFail(t *testing.T, err, category error) {
	t.Helper()
	if !core.Is(err, category) {
		if err == nil {
			t.Fatalf("expected %s, got nil", category.Error())
		}
		t.Fatalf("expected %s, got %s", category.Error(), err.Error())
	}
}

func TestSubmitAndNormalize(t *testing.T) {
	f := newForm(defaultCfg())
	id, err := f.Submit(alice, []string{"Gno Lab", "line1\nline2", "+0042", "tooling"})
	mustFail(t, err, core.ErrInvalidInput) // 42 is below Min
	id, err = f.Submit(alice, []string{"Gno Lab", "line1\nline2", "+2024", "tooling"})
	mustOK(t, err)
	v, ok := f.Submission(id)
	if !ok || v.Answers[2] != "2024" || v.Status != core.SubmissionSubmitted || v.Submitter != alice {
		t.Fatal("stored submission mismatch")
	}
	// optional fields may be empty
	_, err = f.Submit(bob, []string{"Other", "", "", "docs"})
	mustOK(t, err)
}

func TestValidationErrors(t *testing.T) {
	f := newForm(defaultCfg())
	cases := [][]string{
		{"", "", "", "apps"},                       // required title
		{"t", "", "", "games"},                     // bad choice
		{"t", "", "abc", "apps"},                   // bad integer
		{"t\nx", "", "", "apps"},                   // newline in single-line field
		{"t", "", "", "apps", "extra"},             // wrong answer count
		{"t", "", "", ""},                          // required choice
		{string(make([]byte, 61)), "", "", "apps"}, // too long
	}
	for i, c := range cases {
		if _, err := f.Submit(alice, c); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	if f.Count() != 0 {
		t.Fatal("invalid submissions stored")
	}
}

func TestLimits(t *testing.T) {
	f := newForm(Config{MaxSubmissions: 3, MaxPerSubmitter: 2, MaxPayloadBytes: 20})
	_, err := f.Submit(alice, []string{"a", "this summary is long enough", "", "apps"})
	mustFail(t, err, core.ErrLimitExceeded)
	_, err = f.Submit(alice, []string{"a", "", "", "apps"})
	mustOK(t, err)
	_, err = f.Submit(alice, []string{"b", "", "", "apps"})
	mustOK(t, err)
	_, err = f.Submit(alice, []string{"c", "", "", "apps"})
	mustFail(t, err, core.ErrLimitExceeded)
	_, err = f.Submit(bob, []string{"d", "", "", "apps"})
	mustOK(t, err)
	_, err = f.Submit(bob, []string{"e", "", "", "apps"})
	mustFail(t, err, core.ErrLimitExceeded)
}

func TestReviewLifecycle(t *testing.T) {
	f := newForm(defaultCfg())
	a, _ := f.Submit(alice, []string{"a", "", "", "apps"})
	b, _ := f.Submit(bob, []string{"b", "", "", "apps"})
	c, _ := f.Submit(bob, []string{"c", "", "", "docs"})
	mustOK(t, f.Review(a, core.SubmissionAccepted))
	mustOK(t, f.Review(b, core.SubmissionRejected))
	mustFail(t, f.Review(a, core.SubmissionRejected), core.ErrInvalidState)
	mustFail(t, f.Review(c, core.SubmissionSubmitted), core.ErrInvalidInput)
	mustFail(t, f.Review(99, core.SubmissionAccepted), core.ErrNotFound)

	if f.CountByStatus(core.SubmissionAccepted) != 1 || f.CountByStatus(core.SubmissionRejected) != 1 ||
		f.CountByStatus(core.SubmissionSubmitted) != 1 {
		t.Fatal("status counts")
	}
	acc := f.Submissions(int(core.SubmissionAccepted), 0, 25)
	if len(acc) != 1 || acc[0].ID != a {
		t.Fatal("accepted filter")
	}
	if len(f.Submissions(-1, 1, 25)) != 2 {
		t.Fatal("unfiltered paging")
	}
	if len(f.Submissions(int(core.SubmissionSubmitted), 1, 25)) != 0 {
		t.Fatal("filtered offset")
	}
}

func TestSchemaFrozen(t *testing.T) {
	f := newForm(defaultCfg())
	mustOK(t, f.SetFields(projectFields()[:1]))
	_, err := f.Submit(alice, []string{"only title"})
	mustOK(t, err)
	mustFail(t, f.SetFields(projectFields()), core.ErrInvalidState)
}

func TestSchemaValidation(t *testing.T) {
	bad := [][]Field{
		nil,
		{{Name: "Title", Label: "x", Kind: KindText, MaxBytes: 10}},
		{{Name: "t", Label: "x", Kind: KindText, MaxBytes: 0}},
		{{Name: "t", Label: "x", Kind: KindInteger, Min: 5, Max: 1}},
		{{Name: "t", Label: "x", Kind: KindChoice, Choices: []string{"one"}}},
		{{Name: "t", Label: "x", Kind: KindChoice, Choices: []string{"a", "a"}}},
		{{Name: "t", Label: "x", Kind: KindText, MaxBytes: 5}, {Name: "t", Label: "y", Kind: KindText, MaxBytes: 5}},
	}
	f := newForm(defaultCfg())
	for i, fs := range bad {
		if f.SetFields(fs) == nil {
			t.Errorf("schema %d accepted", i)
		}
	}
}

func TestViewsAreCopies(t *testing.T) {
	f := newForm(defaultCfg())
	id, _ := f.Submit(alice, []string{"a", "", "", "apps"})
	v, _ := f.Submission(id)
	v.Answers[0] = "hijack"
	fs := f.Fields()
	fs[3].Choices[0] = "hijack"
	again, _ := f.Submission(id)
	if again.Answers[0] != "a" || f.Fields()[3].Choices[0] != "tooling" {
		t.Fatal("view aliases internal state")
	}
}
