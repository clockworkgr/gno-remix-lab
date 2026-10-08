import { activeOperations, type ClubPollProject } from "@remixlab/spec";
import { gnoBool, gnoInt, gnoPkgPath, gnoString } from "../gno.ts";
import { RULE_CONST, alignConsts, descriptor, gnomod, imports, packageName, type RecipeInput } from "./common.ts";

type Input = RecipeInput<ClubPollProject>;

// Go-style constant names for operations, in recipe order.
const OP_CONST: Record<string, string> = {
  "members.invite": "opInvite",
  "members.remove": "opRemove",
  "members.set_role": "opSetRole",
  "poll.create": "opCreate",
  "poll.open": "opOpen",
  "policy.set": "opPolicy",
};

export function clubPollFiles(input: Input): Record<string, string> {
  return {
    "gnomod.toml": gnomod(input),
    "app.gno": app(input),
    "render.gno": render(input),
    "descriptor.gno": descriptor(input),
    "app_generated_test.gno": generatedTest(input),
  };
}

function app({ spec, recipe, lock }: Input): string {
  const c = spec.config;
  const invitation = c.membership.joinMode === "invitation";
  const members = c.ballots.eligibility === "members";
  const ops = activeOperations(spec, recipe);

  const intro = [
    `// Package ${packageName(spec)} is a Remix Lab "${recipe.id}" app generated from a`,
    `// project configuration. ${invitation ? "Members join by invitation" : "Anyone may join as a member"}; ${
      members ? "members vote in" : "any address may vote in"
    }`,
    `// single-choice polls${members ? " whose electorate is frozen when each poll opens" : ""}.`,
  ];

  const alignedOpConsts = alignConsts(ops.map((o) => [OP_CONST[o.op]!, gnoString(o.op)]));

  const defines = ops.map(
    (o) => `\tpolicy.Define(${OP_CONST[o.op]!}, ${RULE_CONST[c.rules[o.op]!]}, ${RULE_CONST[o.floor]})`,
  );

  const inviteFns = invitation
    ? `
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
`
    : "";

  const openBody = members
    ? `// OpenPoll freezes the poll's options and captures the current members as
// its electorate.
func OpenPoll(cur realm, id uint64) {
	authorize(cur, opOpen)
	electorate, ok := members.Snapshot(core.RoleMember, polls.Config().MaxElectorate)
	if !ok {
		panic(core.Errorf(core.ErrLimitExceeded, "electorate too large").Error())
	}
	must(polls.OpenWithElectorate(id, time.Now().Unix(), electorate))
}`
    : `// OpenPoll freezes the poll's options and opens it to any address.
func OpenPoll(cur realm, id uint64) {
	authorize(cur, opOpen)
	must(polls.OpenPublic(id, time.Now().Unix()))
}`;

  return `${intro.join("\n")}
//
// Authority model: every write derives the actor from cur.Previous(), the
// immediate caller. An intermediary realm calling on a user's behalf acts as
// itself and gains none of that user's roles. Block state lives in
// unexported variables and only inert views leave the realm.
package ${packageName(spec)}

${imports(lock, ["ballots", "core", "membership", "policies"], ["strings", "time"])}

const (
	pkgPath       = ${gnoString(gnoPkgPath(spec.app.pkgPath))}
	appTitle      = ${gnoString(spec.app.title)}
	recipeID      = ${gnoString(recipe.id)}
	recipeVersion = ${gnoString(recipe.version)}
	pageSize      = 25
	optionSep     = "|"
)

// Operation names checked against the policy.
const (
${alignedOpConsts.join("\n")}
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
		JoinMode:   ${invitation ? "membership.JoinInvitation" : "membership.JoinOpen"},
		MaxMembers: ${gnoInt(c.membership.maxMembers)},
	}, owner)

	policy = policies.New(members)
${defines.join("\n")}

	polls = ballots.NewBox(ballots.Config{
		MaxBallots:     ${gnoInt(c.ballots.maxBallots)},
		MaxOptions:     ${gnoInt(c.ballots.maxOptions)},
		MaxElectorate:  ${gnoInt(c.membership.maxMembers)},
		QuorumPercent:  ${gnoInt(c.ballots.quorumPercent)},
		AllowAbstain:   ${gnoBool(c.ballots.allowAbstain)},
		MinDuration:    ${gnoInt(c.ballots.minDurationSeconds)},
		MaxDuration:    ${gnoInt(c.ballots.maxDurationSeconds)},
		MaxTitleBytes:  ${gnoInt(c.ballots.maxTitleBytes)},
		MaxOptionBytes: ${gnoInt(c.ballots.maxOptionBytes)},
	})
}

// --- Membership ---
${inviteFns}
// Join ${invitation ? "accepts the caller's pending invitation" : "adds the caller as a member"}.
func Join(cur realm) {
	ready()
	must(members.Join(cur.Previous().Address()))
}

// Leave removes the caller from the club.${members ? " Open polls keep their frozen\n// electorate." : ""}
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

${openBody}

// Vote casts the caller's vote for option index choice${c.ballots.allowAbstain ? ", or -1 to abstain" : ""}.
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
`;
}

function render({ spec, lock }: Input): string {
  const c = spec.config;
  const invitation = c.membership.joinMode === "invitation";
  const members = c.ballots.eligibility === "members";
  const description = members
    ? "Members vote in single-choice polls. Each poll's electorate is frozen when it opens."
    : "Any address may vote in these single-choice polls.";
  const joinLabel = invitation ? "Join (requires an invitation)" : "Join";
  const voteRule = members ? "electorate frozen at opening (members)" : "any address";

  return `package ${packageName(spec)}

${imports(lock, ["core", "render"], ["strconv", "strings", "time"])}

// Render serves the native pages: overview, polls, a single poll, members
// and rules.
func Render(path string) string {
	if members == nil {
		return render.Heading(1, appTitle) + "This app is not initialized.\\n"
	}
	segs, q := render.ParsePath(path)
	switch {
	case len(segs) == 0:
		return renderHome()
	case segs[0] == "polls" && len(segs) == 1:
		return renderPolls(render.Page(q, render.PageCount(polls.Count(), pageSize)))
	case segs[0] == "polls" && len(segs) == 2:
		id, err := strconv.ParseUint(segs[1], 10, 64)
		if err != nil {
			return notFound()
		}
		return renderPoll(id)
	case segs[0] == "members" && len(segs) == 1:
		return renderMembers(render.Page(q, render.PageCount(members.Size(), pageSize)))
	case segs[0] == "rules" && len(segs) == 1:
		return renderRules()
	}
	return notFound()
}

func renderHome() string {
	var sb strings.Builder
	sb.WriteString(render.Heading(1, appTitle))
	sb.WriteString(${gnoString(description + "\n\n")})
	sb.WriteString("- " + render.Link("Polls", render.RealmURL(pkgPath, "polls")) + " (" + strconv.Itoa(polls.Count()) + ")\\n")
	sb.WriteString("- " + render.Link("Members", render.RealmURL(pkgPath, "members")) + " (" + strconv.Itoa(members.Size()) + ")\\n")
	sb.WriteString("- " + render.Link("Rules", render.RealmURL(pkgPath, "rules")) + "\\n\\n")
	sb.WriteString(render.TxLink(${gnoString(joinLabel)}, pkgPath, "Join") + "\\n\\n")
	sb.WriteString(renderPollTable(polls.List(0, 5)))
	sb.WriteString("_Recipe " + render.Text(recipeID+"@"+recipeVersion) + ". Membership is address-based; one address is not one person._\\n")
	return sb.String()
}

func renderPolls(page int) string {
	pages := render.PageCount(polls.Count(), pageSize)
	return render.Heading(1, "Polls") +
		renderPollTable(polls.List((page-1)*pageSize, pageSize)) +
		render.Pager(pkgPath, "polls", page, pages)
}

func renderPollTable(list []core.BallotView) string {
	if len(list) == 0 {
		return "No polls yet.\\n\\n"
	}
	var rows [][]string
	for _, v := range list {
		rows = append(rows, render.TrustedRow(
			render.Link("#"+strconv.FormatUint(v.ID, 10), render.RealmURL(pkgPath, "polls/"+strconv.FormatUint(v.ID, 10))),
			render.Text(v.Title),
			render.Text(statusLabel(v, time.Now().Unix())),
			strconv.Itoa(v.Turnout),
		))
	}
	return render.Table([]string{"Poll", "Title", "Status", "Ballots"}, rows)
}

func renderPoll(id uint64) string {
	v, ok := polls.Ballot(id)
	if !ok {
		return notFound()
	}
	now := time.Now().Unix()
	idStr := strconv.FormatUint(id, 10)
	var sb strings.Builder
	sb.WriteString(render.Heading(1, v.Title))
	sb.WriteString("Status: **" + render.Text(statusLabel(v, now)) + "**")
	if v.Status != core.BallotDraft {
		sb.WriteString(" · electorate " + strconv.Itoa(v.ElectorateSize) + " · ballots " + strconv.Itoa(v.Turnout))
		sb.WriteString(" · deadline " + render.Text(time.Unix(v.Deadline, 0).UTC().Format(time.RFC3339)))
	}
	sb.WriteString("\\n\\n")

	var rows [][]string
	for i, opt := range v.Options {
		action := ""
		if v.Status == core.BallotOpen && now < v.Deadline {
			action = render.TxLink("vote", pkgPath, "Vote", "id", idStr, "choice", strconv.Itoa(i))
		}
		rows = append(rows, render.TrustedRow(render.Text(opt), strconv.Itoa(v.Counts[i]), action))
	}
	sb.WriteString(render.Table([]string{"Option", "Votes", ""}, rows))

	switch {
	case v.Status == core.BallotDraft:
		sb.WriteString(render.TxLink("Open this poll", pkgPath, "OpenPoll", "id", idStr) + "\\n\\n")
	case v.Status == core.BallotOpen && now >= v.Deadline:
		sb.WriteString(render.TxLink("Finalize result", pkgPath, "Finalize", "id", idStr) + "\\n\\n")
	case v.Status == core.BallotFinalized:
		sb.WriteString("Result: **" + render.Text(outcomeLabel(v)) + "**\\n\\n")
	}
	sb.WriteString(render.Link("All polls", render.RealmURL(pkgPath, "polls")) + "\\n")
	return sb.String()
}

func renderMembers(page int) string {
	var rows [][]string
	for _, m := range members.List((page-1)*pageSize, pageSize) {
		rows = append(rows, render.Row(m.Address.String(), m.Role.String()))
	}
	return render.Heading(1, "Members") +
		render.Table([]string{"Address", "Role"}, rows) +
		render.Pager(pkgPath, "members", page, render.PageCount(members.Size(), pageSize))
}

func renderRules() string {
	var rows [][]string
	for _, r := range policy.List() {
		rows = append(rows, render.Row(r.Op, r.Rule.String(), r.Floor.String()))
	}
	rows = append(rows, render.Row("poll.vote", ${gnoString(voteRule)}, "-"))
	return render.Heading(1, "Rules") +
		render.Table([]string{"Operation", "Who may", "Most permissive allowed"}, rows)
}

func statusLabel(v core.BallotView, now int64) string {
	if v.Status == core.BallotOpen && now >= v.Deadline {
		return "voting ended, awaiting finalization"
	}
	return v.Status.String()
}

func outcomeLabel(v core.BallotView) string {
	if v.Outcome == core.OutcomeWinner && v.Winner >= 0 && v.Winner < len(v.Options) {
		return "winner: " + v.Options[v.Winner]
	}
	return v.Outcome.String()
}

func notFound() string {
	return render.Heading(1, "Not found") + render.Link("Back to the app", render.RealmURL(pkgPath, "")) + "\\n"
}
`;
}

/**
 * A scenario test derived from the same configuration: join, create, open,
 * vote, reject an ineligible voter (or accept it for public polls), finalize
 * and compare the outcome with the configured quorum rule.
 */
function generatedTest({ spec, lock }: Input): string {
  const c = spec.config;
  const invitation = c.membership.joinMode === "invitation";
  const membersOnly = c.ballots.eligibility === "members";
  const canInvite = !invitation || c.rules["members.invite"] !== "nobody";
  const canCreate = c.rules["poll.create"] !== "nobody";
  const canOpen = c.rules["poll.open"] !== "nobody";
  const extra = canInvite ? Math.min(2, c.membership.maxMembers - 1) : 0;
  const names = ["scnAlice", "scnBob"].slice(0, extra);

  const lines: string[] = [];
  const as = (who: string) => lines.push(`\ttesting.SetRealm(testing.NewUserRealm(${who}))`);

  lines.push("\tsetup(scnOwner)");
  lines.push("\tuassert.Equal(t, core.RoleOwner.String(), RoleOf(scnOwner))");
  for (const n of names) {
    if (invitation) {
      as("scnOwner");
      lines.push(`\tInvite(cross(cur), ${n}, "member")`);
    }
    as(n);
    lines.push("\tJoin(cross(cur))");
  }
  lines.push(`\tuassert.Equal(t, ${extra + 1}, len(Members(0, 25)))`);
  as("scnOwner");

  if (!canCreate || !canOpen) {
    const op = !canCreate ? "poll.create" : "poll.open";
    if (!canCreate) {
      lines.push(`\tuassert.AbortsWithMessage(t, cur, "remix: unauthorized: ${op} requires nobody", func() {`);
      lines.push(`\t\tCreatePoll(cross(cur), "T", "a|b", ${gnoInt(c.ballots.minDurationSeconds)})`);
      lines.push("\t})");
    } else {
      lines.push(`\tid := CreatePoll(cross(cur), "T", "a|b", ${gnoInt(c.ballots.minDurationSeconds)})`);
      lines.push(`\tuassert.AbortsWithMessage(t, cur, "remix: unauthorized: ${op} requires nobody", func() {`);
      lines.push("\t\tOpenPoll(cross(cur), id)");
      lines.push("\t})");
    }
  } else {
    lines.push(`\tid := CreatePoll(cross(cur), "T", "a|b", ${gnoInt(c.ballots.minDurationSeconds)})`);
    lines.push("\tOpenPoll(cross(cur), id)");

    // Ballots: every extra member picks option 1; with two extra members the
    // owner picks option 0; with none, the owner picks option 1.
    const ballots: Array<[string, number]> = names.map((n) => [n, 1]);
    if (extra === 2) ballots.push(["scnOwner", 0]);
    if (extra === 0) ballots.push(["scnOwner", 1]);
    for (const [who, choice] of ballots) {
      as(who);
      lines.push(`\tVote(cross(cur), id, ${choice})`);
    }
    let turnout = ballots.length;
    as("scnMallory");
    if (membersOnly) {
      lines.push(`\tuassert.AbortsWithMessage(t, cur, "remix: unauthorized: not in the electorate", func() {`);
      lines.push("\t\tVote(cross(cur), id, 0)");
      lines.push("\t})");
    } else {
      lines.push("\tVote(cross(cur), id, 1)");
      turnout++;
    }
    lines.push(`\tuassert.AbortsWithMessage(t, cur, "remix: invalid state: deadline not reached", func() {`);
    lines.push("\t\tFinalize(cross(cur), id)");
    lines.push("\t})");
    lines.push(`\ttesting.SkipHeights(${gnoInt(Math.floor(c.ballots.minDurationSeconds / 5) + 1)})`);
    lines.push("\tFinalize(cross(cur), id)");
    lines.push("\tv, _ := Poll(id)");
    lines.push(`\tuassert.Equal(t, ${turnout}, v.Turnout)`);

    const electorate = extra + 1;
    const quorumMet = !membersOnly || turnout * 100 >= c.ballots.quorumPercent * electorate;
    lines.push(`\tuassert.Equal(t, int(core.${quorumMet ? "OutcomeWinner" : "OutcomeNoQuorum"}), int(v.Outcome))`);
    if (quorumMet) lines.push("\tuassert.Equal(t, 1, v.Winner)");
  }

  return `package ${packageName(spec)}

${imports(lock, ["core"], ["testing"], ["gno.land/p/nt/testutils/v0", "gno.land/p/nt/uassert/v0"])}

// Generated from the project configuration; regenerate rather than edit.

var (
	scnOwner   = testutils.TestAddress("scn-owner")
	scnAlice   = testutils.TestAddress("scn-alice")
	scnBob     = testutils.TestAddress("scn-bob")
	scnMallory = testutils.TestAddress("scn-mallory")
)

func TestGeneratedScenario(cur realm, t *testing.T) {
${lines.join("\n")}
}
`;
}
