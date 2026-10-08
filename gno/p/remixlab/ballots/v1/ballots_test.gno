package ballots

import (
	"testing"

	"gno.land/p/nt/testutils/v0"
	"gno.land/p/remixlab/core/v1"
)

var (
	alice = testutils.TestAddress("alice")
	bob   = testutils.TestAddress("bob")
	carol = testutils.TestAddress("carol")
	dave  = testutils.TestAddress("dave")
)

const t0 = int64(1_000_000)

func newBox(mut func(*Config)) *Box {
	cfg := DefaultConfig()
	if mut != nil {
		mut(&cfg)
	}
	return NewBox(cfg)
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

func TestHappyPath(t *testing.T) {
	b := newBox(nil)
	id, err := b.Create(alice, "Lunch?", []string{"pizza", "sushi"}, 3600)
	mustOK(t, err)
	mustFail(t, b.Vote(id, alice, 0, t0), core.ErrInvalidState) // draft
	mustOK(t, b.OpenWithElectorate(id, t0, []address{alice, bob, carol}))
	mustOK(t, b.Vote(id, alice, 1, t0+1))
	mustOK(t, b.Vote(id, bob, 1, t0+2))
	mustOK(t, b.Vote(id, carol, 0, t0+3))

	_, err = b.Finalize(id, t0+3599)
	mustFail(t, err, core.ErrInvalidState)
	v, err := b.Finalize(id, t0+3600)
	mustOK(t, err)
	if v.Outcome != core.OutcomeWinner || v.Winner != 1 || v.Turnout != 3 {
		t.Fatalf("unexpected result %s winner=%d", v.Outcome.String(), v.Winner)
	}
	if v.Counts[0]+v.Counts[1] > v.Turnout {
		t.Fatal("tally exceeds accepted ballots")
	}
	_, err = b.Finalize(id, t0+4000)
	mustFail(t, err, core.ErrInvalidState)
}

func TestEligibilityAndUniqueness(t *testing.T) {
	b := newBox(nil)
	id, _ := b.Create(alice, "Q", []string{"a", "b"}, 100)
	mustOK(t, b.OpenWithElectorate(id, t0, []address{alice, bob}))
	mustFail(t, b.Vote(id, dave, 0, t0), core.ErrUnauthorized)
	mustOK(t, b.Vote(id, alice, 0, t0))
	mustFail(t, b.Vote(id, alice, 1, t0), core.ErrConflict)
	mustFail(t, b.Vote(id, bob, 2, t0), core.ErrInvalidInput)
	mustFail(t, b.Vote(id, bob, Abstain, t0), core.ErrInvalidInput) // abstain disabled
	if !b.HasVoted(id, alice) || b.HasVoted(id, bob) {
		t.Fatal("HasVoted")
	}
	// deadline boundary: now == deadline is too late
	mustFail(t, b.Vote(id, bob, 0, t0+100), core.ErrInvalidState)
	mustOK(t, b.Vote(id, bob, 0, t0+99))
}

func TestElectorateFrozen(t *testing.T) {
	b := newBox(nil)
	voters := []address{alice, bob}
	id, _ := b.Create(alice, "Q", []string{"a", "b"}, 100)
	mustOK(t, b.OpenWithElectorate(id, t0, voters))
	voters[1] = carol // caller mutates its slice afterwards
	mustFail(t, b.Vote(id, carol, 0, t0), core.ErrUnauthorized)
	mustOK(t, b.Vote(id, bob, 0, t0))
	mustFail(t, b.OpenWithElectorate(id, t0, []address{carol}), core.ErrInvalidState)
}

func TestTieAndNoVotes(t *testing.T) {
	b := newBox(nil)
	id, _ := b.Create(alice, "Q", []string{"a", "b", "c"}, 100)
	mustOK(t, b.OpenWithElectorate(id, t0, []address{alice, bob, carol}))
	mustOK(t, b.Vote(id, alice, 0, t0))
	mustOK(t, b.Vote(id, bob, 2, t0))
	v, _ := b.Finalize(id, t0+100)
	if v.Outcome != core.OutcomeTie || v.Winner != -1 {
		t.Fatal("expected tie")
	}

	id2, _ := b.Create(alice, "Q2", []string{"a", "b"}, 100)
	mustOK(t, b.OpenWithElectorate(id2, t0, []address{alice}))
	v, _ = b.Finalize(id2, t0+100)
	if v.Outcome != core.OutcomeNoVotes {
		t.Fatal("expected no votes")
	}
}

func TestQuorumAndAbstain(t *testing.T) {
	b := newBox(func(c *Config) {
		c.QuorumPercent = 50
		c.AllowAbstain = true
	})
	// 4 voters, quorum 50% => 2 ballots needed; abstentions count to turnout.
	id, _ := b.Create(alice, "Q", []string{"a", "b"}, 100)
	mustOK(t, b.OpenWithElectorate(id, t0, []address{alice, bob, carol, dave}))
	mustOK(t, b.Vote(id, alice, 0, t0))
	v, _ := b.Ballot(id)
	if v.Outcome != core.OutcomePending {
		t.Fatal("pending before finalize")
	}
	id2, _ := b.Create(alice, "Q2", []string{"a", "b"}, 100)
	mustOK(t, b.OpenWithElectorate(id2, t0, []address{alice, bob, carol, dave}))
	mustOK(t, b.Vote(id2, alice, 0, t0))
	mustOK(t, b.Vote(id2, bob, Abstain, t0))

	v, _ = b.Finalize(id, t0+100)
	if v.Outcome != core.OutcomeNoQuorum {
		t.Fatalf("expected no quorum, got %s", v.Outcome.String())
	}
	v, _ = b.Finalize(id2, t0+100)
	if v.Outcome != core.OutcomeWinner || v.Winner != 0 || v.Abstentions != 1 {
		t.Fatalf("expected winner with abstention, got %s", v.Outcome.String())
	}

	// only abstentions: quorum met but nobody chose an option
	id3, _ := b.Create(alice, "Q3", []string{"a", "b"}, 100)
	mustOK(t, b.OpenWithElectorate(id3, t0, []address{alice, bob}))
	mustOK(t, b.Vote(id3, alice, Abstain, t0))
	v, _ = b.Finalize(id3, t0+100)
	if v.Outcome != core.OutcomeNoVotes {
		t.Fatal("abstain-only must not produce a winner")
	}
}

func TestVoteOrderIndependence(t *testing.T) {
	voters := []address{alice, bob, carol, dave}
	choices := []int{1, 0, 1, 1}
	var results []core.BallotView
	for _, order := range [][]int{{0, 1, 2, 3}, {3, 2, 1, 0}, {2, 0, 3, 1}} {
		b := newBox(nil)
		id, _ := b.Create(alice, "Q", []string{"a", "b"}, 100)
		mustOK(t, b.OpenWithElectorate(id, t0, voters))
		for _, i := range order {
			mustOK(t, b.Vote(id, voters[i], choices[i], t0))
		}
		v, _ := b.Finalize(id, t0+100)
		results = append(results, v)
	}
	for _, r := range results[1:] {
		if r.Winner != results[0].Winner || r.Counts[0] != results[0].Counts[0] || r.Counts[1] != results[0].Counts[1] {
			t.Fatal("vote order changed the tally")
		}
	}
}

func TestPublicBallot(t *testing.T) {
	b := newBox(nil)
	id, _ := b.Create(alice, "Q", []string{"a", "b"}, 100)
	mustOK(t, b.OpenPublic(id, t0))
	mustOK(t, b.Vote(id, dave, 1, t0))
	mustFail(t, b.Vote(id, address("bogus"), 1, t0), core.ErrUnauthorized)

	q := newBox(func(c *Config) { c.QuorumPercent = 10 })
	id, _ = q.Create(alice, "Q", []string{"a", "b"}, 100)
	mustFail(t, q.OpenPublic(id, t0), core.ErrInvalidState)
}

func TestCreateValidation(t *testing.T) {
	b := newBox(func(c *Config) {
		c.MaxBallots = 1
		c.MaxOptions = 3
	})
	_, err := b.Create(alice, "", []string{"a", "b"}, 100)
	mustFail(t, err, core.ErrInvalidInput)
	_, err = b.Create(alice, "Q", []string{"a"}, 100)
	mustFail(t, err, core.ErrInvalidInput)
	_, err = b.Create(alice, "Q", []string{"a", "b", "c", "d"}, 100)
	mustFail(t, err, core.ErrLimitExceeded)
	_, err = b.Create(alice, "Q", []string{"a", "a"}, 100)
	mustFail(t, err, core.ErrInvalidInput)
	_, err = b.Create(alice, "Q", []string{"a", "b\n"}, 100)
	mustFail(t, err, core.ErrInvalidInput)
	_, err = b.Create(alice, "Q", []string{"a", "b"}, 1)
	mustFail(t, err, core.ErrInvalidInput)
	_, err = b.Create(alice, "Q", []string{"a", "b"}, 100)
	mustOK(t, err)
	_, err = b.Create(alice, "Q", []string{"a", "b"}, 100)
	mustFail(t, err, core.ErrLimitExceeded)
}

func TestElectorateBounds(t *testing.T) {
	b := newBox(func(c *Config) { c.MaxElectorate = 2 })
	id, _ := b.Create(alice, "Q", []string{"a", "b"}, 100)
	mustFail(t, b.OpenWithElectorate(id, t0, nil), core.ErrInvalidInput)
	mustFail(t, b.OpenWithElectorate(id, t0, []address{alice, bob, carol}), core.ErrLimitExceeded)
	mustFail(t, b.OpenWithElectorate(id, t0, []address{alice, address("x")}), core.ErrInvalidInput)
	mustOK(t, b.OpenWithElectorate(id, t0, []address{alice, bob}))
}

func TestViewIsInert(t *testing.T) {
	b := newBox(nil)
	id, _ := b.Create(alice, "Q", []string{"a", "b"}, 100)
	mustOK(t, b.OpenWithElectorate(id, t0, []address{alice}))
	v, _ := b.Ballot(id)
	v.Options[0] = "hijacked"
	v.Counts[0] = 99
	again, _ := b.Ballot(id)
	if again.Options[0] != "a" || again.Counts[0] != 0 {
		t.Fatal("view aliases internal state")
	}
}

func TestListNewestFirst(t *testing.T) {
	b := newBox(nil)
	for i := 0; i < 3; i++ {
		b.Create(alice, "Q", []string{"a", "b"}, 100)
	}
	l := b.List(0, 2)
	if len(l) != 2 || l[0].ID != 3 || l[1].ID != 2 {
		t.Fatal("list order")
	}
}
