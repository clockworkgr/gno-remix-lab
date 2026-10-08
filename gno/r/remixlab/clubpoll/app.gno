// Package clubpoll is a Remix Lab "club-poll" app generated from a
// project configuration. Members join by invitation; members vote in
// single-choice polls whose electorate is frozen when each poll opens.
//
// Authority model: every write derives the actor from cur.Previous(), the
// immediate caller. An intermediary realm calling on a user's behalf acts as
// itself and gains none of that user's roles. Block state lives in
// unexported variables and only inert views leave the realm.
package clubpoll

import (
	"strings"
	"time"

	"gno.land/p/remixlab/ballots/v1"
	"gno.land/p/remixlab/core/v1"
	"gno.land/p/remixlab/membership/v1"
	"gno.land/p/remixlab/policies/v1"
)

const (
	pkgPath       = "gno.land/r/remixlab/clubpoll"
	appTitle      = "Club poll"
	recipeID      = "club-poll"
	recipeVersion = "1.0.0"
	pageSize      = 25
	optionSep     = "|"
)

// Operation names checked against the policy.
const (
	opInvite  = "members.invite"
	opRemove  = "members.remove"
	opSetRole = "members.set_role"
	opCreate  = "poll.create"
	opOpen    = "poll.open"
	opPolicy  = "policy.set"
)

var (
	members *membership.Set
	policy  *policies.Policy
	polls   *ballots.Box
)

// init captures the deployer as the first owner. A realm whose deployer is
// not a user stays uninitialized and rejects every write; there is no
// separate initialization call that someone else could front-run.
func init(cur realm) {
	deployer := cur.Previous()
	if deployer.IsUser() && deployer.Address().IsValid() {
		setup(deployer.Address())
	}
}

func setup(owner address) {
	members = membership.New(membership.Config{
		JoinMode:   membership.JoinInvitation,
		MaxMembers: 100,
	}, owner)

	policy = policies.New(members)
	policy.Define(opInvite, policies.RuleOwner, policies.RuleReviewer)
	policy.Define(opRemove, policies.RuleOwner, policies.RuleOwner)
	policy.Define(opSetRole, policies.RuleOwner, policies.RuleOwner)
	policy.Define(opCreate, policies.RuleOwner, policies.RuleReviewer)
	policy.Define(opOpen, policies.RuleOwner, policies.RuleReviewer)
	policy.Define(opPolicy, policies.RuleOwner, policies.RuleOwner)

	polls = ballots.NewBox(ballots.Config{
		MaxBallots:     100,
		MaxOptions:     20,
		MaxElectorate:  100,
		QuorumPercent:  0,
		AllowAbstain:   false,
		MinDuration:    60,
		MaxDuration:    2592000,
		MaxTitleBytes:  140,
		MaxOptionBytes: 80,
	})
}

// --- Membership ---

// Invite lets addr join with role ("member" or "reviewer").
func Invite(cur realm, addr address, role string) {
	actor := authorize(cur, opInvite)
	r, err := core.ParseRole(role)
	must(err)
	if r == core.RoleOwner {
		// Owners are appointed by an owner through SetRole, never invited by
		// a reviewer.
		must(policy.Authorize(opSetRole, actor))
	}
	must(members.Invite(addr, r))
}

// RevokeInvite cancels a pending invitation.
func RevokeInvite(cur realm, addr address) {
	authorize(cur, opInvite)
	must(members.RevokeInvite(addr))
}

// Join accepts the caller's pending invitation.
func Join(cur realm) {
	ready()
	must(members.Join(cur.Previous().Address()))
}

// Leave removes the caller from the club. Open polls keep their frozen
// electorate.
func Leave(cur realm) {
	ready()
	must(members.Leave(cur.Previous().Address()))
}

// RemoveMember removes addr.
func RemoveMember(cur realm, addr address) {
	authorize(cur, opRemove)
	must(members.Remove(addr))
}

// SetRole changes addr's role.
func SetRole(cur realm, addr address, role string) {
	authorize(cur, opSetRole)
	r, err := core.ParseRole(role)
	must(err)
	must(members.SetRole(addr, r))
}

// --- Polls ---

// CreatePoll creates a draft poll. options are separated by "|".
func CreatePoll(cur realm, title string, options string, durationSeconds int64) uint64 {
	actor := authorize(cur, opCreate)
	id, err := polls.Create(actor, title, strings.Split(options, optionSep), durationSeconds)
	must(err)
	return id
}

// OpenPoll freezes the poll's options and captures the current members as
// its electorate.
func OpenPoll(cur realm, id uint64) {
	authorize(cur, opOpen)
	electorate, ok := members.Snapshot(core.RoleMember, polls.Config().MaxElectorate)
	if !ok {
		panic(core.Errorf(core.ErrLimitExceeded, "electorate too large").Error())
	}
	must(polls.OpenWithElectorate(id, time.Now().Unix(), electorate))
}

// Vote casts the caller's vote for option index choice.
func Vote(cur realm, id uint64, choice int) {
	ready()
	must(polls.Vote(id, cur.Previous().Address(), choice, time.Now().Unix()))
}

// Finalize commits a poll's result once its deadline has passed. Anyone may
// call it; the result depends only on rules frozen at opening.
func Finalize(cur realm, id uint64) {
	ready()
	_, err := polls.Finalize(id, time.Now().Unix())
	must(err)
}

// --- Policy ---

// SetRule changes the rule for an operation, within that operation's floor.
func SetRule(cur realm, op string, rule string) {
	authorize(cur, opPolicy)
	r, err := policies.ParseRule(rule)
	must(err)
	must(policy.Set(op, r))
}

// --- Reads ---

// Poll returns an inert summary of poll id.
func Poll(id uint64) (core.BallotView, bool) {
	ready()
	return polls.Ballot(id)
}

// Polls pages through polls, newest first.
func Polls(offset, limit int) []core.BallotView {
	ready()
	return polls.List(offset, clampLimit(limit))
}

// Members pages through members ordered by address.
func Members(offset, limit int) []core.MemberView {
	ready()
	return members.List(offset, clampLimit(limit))
}

// RoleOf returns addr's role name.
func RoleOf(addr address) string {
	ready()
	return members.RoleOf(addr).String()
}

// HasVoted reports whether addr voted in poll id.
func HasVoted(id uint64, addr address) bool {
	ready()
	return polls.HasVoted(id, addr)
}

// Rules lists every operation's current rule.
func Rules() []policies.RuleView {
	ready()
	return policy.List()
}

// --- Internals ---

func authorize(cur realm, op string) address {
	ready()
	actor := cur.Previous().Address()
	must(policy.Authorize(op, actor))
	return actor
}

func ready() {
	if members == nil {
		panic(core.Errorf(core.ErrInvalidState, "app is not initialized").Error())
	}
}

func clampLimit(limit int) int {
	if limit < 1 || limit > pageSize {
		return pageSize
	}
	return limit
}

func must(err error) {
	if err != nil {
		panic(err.Error())
	}
}
