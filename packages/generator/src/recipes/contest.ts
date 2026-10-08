import { CONTEST_MAX_TITLE_BYTES, activeOperations, type ContestProject, type Rule } from "@remixlab/spec";
import { gnoBool, gnoInt, gnoPkgPath, gnoString } from "../gno.ts";
import { fieldDoc, fieldLiteral, sampleAnswer } from "./formfields.ts";
import { RULE_CONST, alignConsts, descriptor, gnomod, imports, packageName, type RecipeInput } from "./common.ts";

type Input = RecipeInput<ContestProject>;

const OP_CONST: Record<string, string> = {
  "members.invite": "opInvite",
  "members.remove": "opRemove",
  "members.set_role": "opSetRole",
  "entry.submit": "opSubmit",
  "entry.review": "opReview",
  "contest.open": "opOpen",
  "policy.set": "opPolicy",
};

// Ballot options are "#<entry id> <title>"; a uint64 id adds at most 22 bytes.
const OPTION_PREFIX_BYTES = 22;

export function contestFiles(input: Input): Record<string, string> {
  return {
    "gnomod.toml": gnomod(input),
    "app.gno": app(input),
    "render.gno": render(input),
    "descriptor.gno": descriptor(input),
    "app_generated_test.gno": generatedTest(input),
  };
}

function titleField(spec: ContestProject) {
  const f = spec.config.form.fields.find((x) => x.name === spec.config.form.titleField);
  if (!f || f.kind !== "text") throw new Error("unreachable: title field is validated by the schema");
  return f;
}

function app({ spec, recipe, lock }: Input): string {
  const c = spec.config;
  const invitation = c.membership.joinMode === "invitation";
  const membersOnly = c.contest.eligibility === "members";
  const ops = activeOperations(spec, recipe);
  const fields = c.form.fields;
  const titleIndex = fields.findIndex((f) => f.name === c.form.titleField);

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

  const openBallot = membersOnly
    ? `	electorate, ok := members.Snapshot(core.RoleMember, maxElectorate)
	if !ok {
		panic(core.Errorf(core.ErrLimitExceeded, "electorate too large").Error())
	}
	must(ballot.OpenWithElectorate(id, time.Now().Unix(), electorate))`
    : "\tmust(ballot.OpenPublic(id, time.Now().Unix()))";

  return `// Package ${packageName(spec)} is a Remix Lab "${recipe.id}" app generated
// from a project configuration. Entrants submit through a fixed form,
// reviewers admit up to ${c.contest.maxEntries} entries, and ${membersOnly ? "members" : "any address"} vote${membersOnly ? "" : "s"} for a winner.
//
// The contest runs once: opening the vote closes submissions and review,
// freezes the admitted entries as the ballot's options${membersOnly ? " and captures the\n// current members as the electorate" : ""}. Every submission is public chain
// data, including entries that are later rejected.
//
// Authority model: every write derives the actor from cur.Previous(), the
// immediate caller. An intermediary realm calling on a user's behalf acts as
// itself and gains none of that user's roles. Block state lives in
// unexported variables and only inert views leave the realm.
package ${packageName(spec)}

${imports(lock, ["ballots", "core", "forms", "membership", "policies"], ["strconv", "time"])}

const (
${alignConsts([
  ["pkgPath", gnoString(gnoPkgPath(spec.app.pkgPath))],
  ["appTitle", gnoString(spec.app.title)],
  ["recipeID", gnoString(recipe.id)],
  ["recipeVersion", gnoString(recipe.version)],
  ["pageSize", "25"],
  ["maxEntries", gnoInt(c.contest.maxEntries)],
  ["maxElectorate", gnoInt(c.membership.maxMembers)],
]).join("\n")}
)

// titleIndex is the form field shown as each entry's title.
const titleIndex = ${gnoInt(titleIndex)}

// Operation names checked against the policy.
const (
${alignConsts(ops.map((o) => [OP_CONST[o.op]!, gnoString(o.op)])).join("\n")}
)

var (
	members *membership.Set
	policy  *policies.Policy
	entries *forms.Form
	ballot  *ballots.Box

	// ballotID is 0 until voting opens; ballotEntries maps each ballot
	// option index to its entry ID.
	ballotID      uint64
	ballotEntries []uint64
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
		MaxMembers: maxElectorate,
	}, owner)

	policy = policies.New(members)
${defines.join("\n")}

	entries = forms.New(forms.Config{
		MaxSubmissions:  ${gnoInt(c.form.maxSubmissions)},
		MaxPerSubmitter: ${gnoInt(c.form.maxPerSubmitter)},
		MaxPayloadBytes: ${gnoInt(c.form.maxPayloadBytes)},
	}, []forms.Field{
${fields.map(fieldLiteral).join("\n")}
	})

	ballot = ballots.NewBox(ballots.Config{
		MaxBallots:     1,
		MaxOptions:     maxEntries,
		MaxElectorate:  maxElectorate,
		QuorumPercent:  ${gnoInt(c.contest.quorumPercent)},
		AllowAbstain:   false,
		MinDuration:    ${gnoInt(c.contest.minDurationSeconds)},
		MaxDuration:    ${gnoInt(c.contest.maxDurationSeconds)},
		MaxTitleBytes:  ${gnoInt(CONTEST_MAX_TITLE_BYTES)},
		MaxOptionBytes: ${gnoInt(titleField(spec).maxBytes + OPTION_PREFIX_BYTES)},
	})
	ballotID = 0
	ballotEntries = nil
}

// --- Entries ---

// Submit stores a contest entry for review and returns its ID. Every answer
// is public. Leave optional fields empty.
${fields.map(fieldDoc).join("\n")}
func Submit(cur realm, ${fields.map((f) => `${f.name} string`).join(", ")}) uint64 {
	actor := authorize(cur, opSubmit)
	mustBeOpenForEntries()
	id, err := entries.Submit(actor, []string{${fields.map((f) => f.name).join(", ")}})
	must(err)
	return id
}

// Accept admits a submitted entry to the ballot. Decisions are final.
func Accept(cur realm, id uint64) {
	authorize(cur, opReview)
	mustBeOpenForEntries()
	if entries.CountByStatus(core.SubmissionAccepted) >= maxEntries {
		panic(core.Errorf(core.ErrLimitExceeded, "the contest already has "+strconv.Itoa(maxEntries)+" entries").Error())
	}
	must(entries.Review(id, core.SubmissionAccepted))
}

// Reject declines a submitted entry. Decisions are final.
func Reject(cur realm, id uint64) {
	authorize(cur, opReview)
	mustBeOpenForEntries()
	must(entries.Review(id, core.SubmissionRejected))
}

// --- Voting ---

// OpenVoting closes submissions and review, turns the admitted entries into
// the ballot's options${membersOnly ? ", captures the current members as the electorate" : ""} and
// opens voting for durationSeconds.
func OpenVoting(cur realm, durationSeconds int64) {
	actor := authorize(cur, opOpen)
	mustBeOpenForEntries()
	admitted := entries.Submissions(int(core.SubmissionAccepted), 0, maxEntries)
	if len(admitted) < 2 {
		panic(core.Errorf(core.ErrInvalidState, "at least two admitted entries are required").Error())
	}
	options := make([]string, len(admitted))
	ids := make([]uint64, len(admitted))
	for i, e := range admitted {
		ids[i] = e.ID
		options[i] = "#" + strconv.FormatUint(e.ID, 10) + " " + e.Answers[titleIndex]
	}
	id, err := ballot.Create(actor, appTitle, options, durationSeconds)
	must(err)
${openBallot}
	ballotID = id
	ballotEntries = ids
}

// Vote casts the caller's vote for an admitted entry.
func Vote(cur realm, entryID uint64) {
	ready()
	if ballotID == 0 {
		panic(core.Errorf(core.ErrInvalidState, "voting has not opened").Error())
	}
	choice := -1
	for i, id := range ballotEntries {
		if id == entryID {
			choice = i
		}
	}
	if choice < 0 {
		panic(core.Errorf(core.ErrNotFound, "entry is not on the ballot").Error())
	}
	must(ballot.Vote(ballotID, cur.Previous().Address(), choice, time.Now().Unix()))
}

// Finalize commits the result once the deadline has passed. Anyone may call
// it; the result depends only on rules frozen when voting opened.
func Finalize(cur realm) {
	ready()
	if ballotID == 0 {
		panic(core.Errorf(core.ErrInvalidState, "voting has not opened").Error())
	}
	_, err := ballot.Finalize(ballotID, time.Now().Unix())
	must(err)
}

// --- Membership ---
${inviteFns}
// Join ${invitation ? "accepts the caller's pending invitation" : "adds the caller as a member"}.
func Join(cur realm) {
	ready()
	must(members.Join(cur.Previous().Address()))
}

// Leave removes the caller from the membership.${membersOnly ? " An open vote keeps its frozen\n// electorate." : ""}
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

// --- Policy ---

// SetRule changes the rule for an operation, within that operation's floor.
func SetRule(cur realm, op string, rule string) {
	authorize(cur, opPolicy)
	r, err := policies.ParseRule(rule)
	must(err)
	must(policy.Set(op, r))
}

// --- Reads ---

// Entry returns an inert copy of entry id in any status.
func Entry(id uint64) (core.SubmissionView, bool) {
	ready()
	return entries.Submission(id)
}

// Entries lists the admitted entries in submission order.
func Entries() []core.SubmissionView {
	ready()
	return entries.Submissions(int(core.SubmissionAccepted), 0, maxEntries)
}

// Queue pages through entries awaiting review in submission order.
func Queue(offset, limit int) []core.SubmissionView {
	ready()
	return entries.Submissions(int(core.SubmissionSubmitted), offset, clampLimit(limit))
}

// Fields returns a copy of the form schema.
func Fields() []forms.Field {
	ready()
	return entries.Fields()
}

// Ballot returns the contest ballot once voting has opened.
func Ballot() (core.BallotView, bool) {
	ready()
	if ballotID == 0 {
		return core.BallotView{}, false
	}
	return ballot.Ballot(ballotID)
}

// BallotEntries returns the entry ID of each ballot option, in option order.
func BallotEntries() []uint64 {
	ready()
	out := make([]uint64, len(ballotEntries))
	copy(out, ballotEntries)
	return out
}

// Winner returns the winning entry once the result is final and has a
// single winner.
func Winner() (uint64, bool) {
	ready()
	v, ok := Ballot()
	if !ok || v.Status != core.BallotFinalized || v.Outcome != core.OutcomeWinner {
		return 0, false
	}
	return ballotEntries[v.Winner], true
}

// HasVoted reports whether addr has voted.
func HasVoted(addr address) bool {
	ready()
	return ballotID != 0 && ballot.HasVoted(ballotID, addr)
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

func mustBeOpenForEntries() {
	if ballotID != 0 {
		panic(core.Errorf(core.ErrInvalidState, "submissions are closed").Error())
	}
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
  const joinLabel = c.membership.joinMode === "invitation" ? "Join (requires an invitation)" : "Join";
  const voteRule = c.contest.eligibility === "members" ? "electorate frozen when voting opens (members)" : "any address";

  return `package ${packageName(spec)}

${imports(lock, ["core", "render"], ["strconv", "strings", "time"])}

// Render serves the native pages: overview (entries, ballot and result), a
// single entry, the review queue, members and rules.
func Render(path string) string {
	if members == nil {
		return render.Heading(1, appTitle) + "This app is not initialized.\\n"
	}
	segs, q := render.ParsePath(path)
	switch {
	case len(segs) == 0:
		return renderHome()
	case segs[0] == "entries" && len(segs) == 2:
		id, err := strconv.ParseUint(segs[1], 10, 64)
		if err != nil {
			return notFound()
		}
		return renderEntry(id)
	case segs[0] == "queue" && len(segs) == 1:
		return renderQueue(render.Page(q, render.PageCount(entries.CountByStatus(core.SubmissionSubmitted), pageSize)))
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
	v, voting := Ballot()
	now := time.Now().Unix()
	switch {
	case !voting:
		sb.WriteString("**Taking entries.** Reviewers admit up to " + strconv.Itoa(maxEntries) + " entries; then voting opens on the admitted entries.\\n\\n")
		sb.WriteString(render.TxLink("Submit an entry", pkgPath, "Submit") + " · " +
			render.Link("Review queue", render.RealmURL(pkgPath, "queue")) + " (" + strconv.Itoa(entries.CountByStatus(core.SubmissionSubmitted)) + ") · " +
			render.TxLink("Open voting", pkgPath, "OpenVoting") + "\\n\\n")
	case v.Status == core.BallotOpen && now < v.Deadline:
		sb.WriteString("**Voting is open** until " + render.Text(time.Unix(v.Deadline, 0).UTC().Format(time.RFC3339)) +
			" · electorate " + strconv.Itoa(v.ElectorateSize) + " · ballots " + strconv.Itoa(v.Turnout) + "\\n\\n")
	case v.Status == core.BallotOpen:
		sb.WriteString("**Voting ended, awaiting finalization.** " + render.TxLink("Finalize result", pkgPath, "Finalize") + "\\n\\n")
	default:
		sb.WriteString("**Result: " + render.Text(resultLabel(v)) + "** · ballots " + strconv.Itoa(v.Turnout) + "\\n\\n")
	}

	var rows [][]string
	for i, e := range Entries() {
		idStr := strconv.FormatUint(e.ID, 10)
		row := []string{
			render.Link("#"+idStr, render.RealmURL(pkgPath, "entries/"+idStr)),
			render.Text(e.Answers[titleIndex]),
		}
		if voting {
			row = append(row, strconv.Itoa(v.Counts[i]))
			if v.Status == core.BallotOpen && now < v.Deadline {
				row = append(row, render.TxLink("vote", pkgPath, "Vote", "entryID", idStr))
			} else {
				row = append(row, "")
			}
		}
		rows = append(rows, render.TrustedRow(row...))
	}
	headers := []string{"Entry", "Title"}
	if voting {
		headers = append(headers, "Votes", "")
	}
	if len(rows) == 0 {
		sb.WriteString("No admitted entries yet.\\n\\n")
	} else {
		sb.WriteString(render.Table(headers, rows))
	}

	sb.WriteString("- " + render.Link("Members", render.RealmURL(pkgPath, "members")) + " (" + strconv.Itoa(members.Size()) + ") · " +
		render.TxLink(${gnoString(joinLabel)}, pkgPath, "Join") + "\\n")
	sb.WriteString("- " + render.Link("Rules", render.RealmURL(pkgPath, "rules")) + "\\n\\n")
	sb.WriteString("_Recipe " + render.Text(recipeID+"@"+recipeVersion) + ". Membership is address-based; one address is not one person._\\n")
	return sb.String()
}

func renderQueue(page int) string {
	list := entries.Submissions(int(core.SubmissionSubmitted), (page-1)*pageSize, pageSize)
	if len(list) == 0 {
		return render.Heading(1, "Review queue") + "Nothing to review.\\n"
	}
	var rows [][]string
	for _, e := range list {
		idStr := strconv.FormatUint(e.ID, 10)
		rows = append(rows, render.TrustedRow(
			render.Link("#"+idStr, render.RealmURL(pkgPath, "entries/"+idStr)),
			render.Text(e.Answers[titleIndex]),
			reviewLinks(idStr),
		))
	}
	return render.Heading(1, "Review queue") +
		render.Table([]string{"Entry", "Title", "Review"}, rows) +
		render.Pager(pkgPath, "queue", page, render.PageCount(entries.CountByStatus(core.SubmissionSubmitted), pageSize))
}

func renderEntry(id uint64) string {
	v, ok := entries.Submission(id)
	if !ok {
		return notFound()
	}
	idStr := strconv.FormatUint(id, 10)
	if v.Status == core.SubmissionRejected {
		return render.Heading(1, "Entry #"+idStr) + "This entry was rejected.\\n\\n" +
			render.Link("Back to the contest", render.RealmURL(pkgPath, "")) + "\\n"
	}
	status := "admitted"
	if v.Status == core.SubmissionSubmitted {
		status = "awaiting review"
	}
	var sb strings.Builder
	sb.WriteString(render.Heading(1, v.Answers[titleIndex]))
	sb.WriteString("Status: **" + status + "** · submitted by " + render.Code(v.Submitter.String()) + "\\n\\n")
	var rows [][]string
	for i, f := range entries.Fields() {
		if i != titleIndex && v.Answers[i] != "" {
			rows = append(rows, render.Row(f.Label, v.Answers[i]))
		}
	}
	if len(rows) > 0 {
		sb.WriteString(render.Table([]string{"Field", "Answer"}, rows))
	}
	if v.Status == core.SubmissionSubmitted && ballotID == 0 {
		sb.WriteString("Review: " + reviewLinks(idStr) + "\\n\\n")
	}
	sb.WriteString(render.Link("Back to the contest", render.RealmURL(pkgPath, "")) + "\\n")
	return sb.String()
}

func reviewLinks(idStr string) string {
	return render.TxLink("admit", pkgPath, "Accept", "id", idStr) + " · " +
		render.TxLink("reject", pkgPath, "Reject", "id", idStr)
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
	rows = append(rows, render.Row("contest.vote", ${gnoString(voteRule)}, "-"))
	return render.Heading(1, "Rules") +
		render.Table([]string{"Operation", "Who may", "Most permissive allowed"}, rows) +
		${gnoString(limitsNote(spec))} + "\\n"
}

func resultLabel(v core.BallotView) string {
	if w, ok := Winner(); ok {
		return "winner: " + v.Options[v.Winner] + " (entry " + strconv.FormatUint(w, 10) + ")"
	}
	return v.Outcome.String()
}

func notFound() string {
	return render.Heading(1, "Not found") + render.Link("Back to the app", render.RealmURL(pkgPath, "")) + "\\n"
}
`;
}

function limitsNote(spec: ContestProject): string {
  const c = spec.config;
  const per = c.form.maxPerSubmitter > 0 ? `, at most ${c.form.maxPerSubmitter} per address` : "";
  const quorum = c.contest.quorumPercent > 0 ? ` Quorum: ${c.contest.quorumPercent}% of the electorate.` : "";
  return `Up to ${c.form.maxSubmissions} submissions${per}; at most ${c.contest.maxEntries} admitted entries. Review decisions are final; a tie has no winner.${quorum}`;
}

const ROLE_FOR_RULE: Partial<Record<Rule, string>> = {
  member: "core.RoleMember",
  reviewer: "core.RoleReviewer",
  owner: "core.RoleOwner",
};

/**
 * A scenario test derived from the same configuration: submit and admit two
 * entries, open voting, vote, reject an ineligible voter (or count it for
 * public voting), finalize and compare the outcome with the quorum rule.
 * Voters and entrants are seated directly so the scenario does not depend
 * on the configured invitation rules.
 */
function generatedTest({ spec, lock }: Input): string {
  const c = spec.config;
  const answers = c.form.fields.map((f) => sampleAnswer(f));
  const payload = answers.reduce((n, a) => n + new TextEncoder().encode(a).length, 0);
  const args = gnoArgs(answers);
  const submitRule = c.rules["entry.submit"]!;
  const reviewRule = c.rules["entry.review"]!;
  const openRule = c.rules["contest.open"]!;
  const membersOnly = c.contest.eligibility === "members";

  // Who submits the two entries.
  let entrants: [string, string];
  let seatedEntrant = false;
  if (submitRule === "public") entrants = ["scnEntrant1", "scnEntrant2"];
  else if (submitRule !== "nobody" && c.form.maxPerSubmitter === 1) {
    entrants = ["scnOwner", "scnEntrant2"];
    seatedEntrant = true;
  } else entrants = ["scnOwner", "scnOwner"];
  const twoEntries = !seatedEntrant || c.membership.maxMembers >= 2;
  const extra = Math.max(0, Math.min(2, c.membership.maxMembers - 1 - (seatedEntrant ? 1 : 0)));
  const voters = ["scnAlice", "scnBob"].slice(0, extra);

  const lines: string[] = [];
  const as = (who: string) => lines.push(`\ttesting.SetRealm(testing.NewUserRealm(${who}))`);
  const aborts = (msg: string, call: string) => {
    lines.push(`\tuassert.AbortsWithMessage(t, cur, ${gnoString(msg)}, func() {`);
    lines.push(`\t\t${call}`);
    lines.push("\t})");
  };

  lines.push("\tsetup(scnOwner)");
  for (const v of voters) lines.push(`\tuassert.NoError(t, members.Add(${v}, core.RoleMember))`);
  if (seatedEntrant && twoEntries) {
    lines.push(`\tuassert.NoError(t, members.Add(scnEntrant2, ${ROLE_FOR_RULE[submitRule]!}))`);
  }

  const scenario = (): void => {
    as(entrants[0]);
    if (submitRule === "nobody") return aborts("remix: unauthorized: entry.submit requires nobody", `Submit(cross(cur), ${args})`);
    if (payload > c.form.maxPayloadBytes) {
      return aborts("remix: limit exceeded: answers too large", `Submit(cross(cur), ${args})`);
    }
    lines.push(`\tSubmit(cross(cur), ${args})`);
    if (!twoEntries) {
      as("scnOwner");
      lines.push("\tAccept(cross(cur), 1)");
      return aborts("remix: invalid state: at least two admitted entries are required", "OpenVoting(cross(cur), 0)");
    }
    as(entrants[1]);
    lines.push(`\tSubmit(cross(cur), ${args})`);

    as("scnMallory");
    aborts(`remix: unauthorized: entry.review requires ${reviewRule}`, "Accept(cross(cur), 1)");
    if (reviewRule === "nobody") return;
    as("scnOwner");
    lines.push("\tAccept(cross(cur), 1)");
    lines.push("\tAccept(cross(cur), 2)");
    lines.push("\tuassert.Equal(t, 2, len(Entries()))");

    if (openRule === "nobody") {
      return aborts("remix: unauthorized: contest.open requires nobody", `OpenVoting(cross(cur), ${gnoInt(c.contest.minDurationSeconds)})`);
    }
    lines.push(`\tOpenVoting(cross(cur), ${gnoInt(c.contest.minDurationSeconds)})`);
    as(entrants[0]);
    aborts("remix: invalid state: submissions are closed", `Submit(cross(cur), ${args})`);

    // Every seated voter picks entry 2; with two of them the owner picks
    // entry 1, otherwise the owner also picks entry 2.
    const ballots: Array<[string, number]> = voters.map((v) => [v, 2]);
    ballots.push(["scnOwner", extra === 2 ? 1 : 2]);
    for (const [who, entry] of ballots) {
      as(who);
      lines.push(`\tVote(cross(cur), ${entry})`);
    }
    let turnout = ballots.length;
    as("scnMallory");
    if (membersOnly) aborts("remix: unauthorized: not in the electorate", "Vote(cross(cur), 1)");
    else {
      lines.push("\tVote(cross(cur), 2)");
      turnout++;
    }
    aborts("remix: not found: entry is not on the ballot", "Vote(cross(cur), 99)");
    aborts("remix: invalid state: deadline not reached", "Finalize(cross(cur))");
    lines.push(`\ttesting.SkipHeights(${gnoInt(Math.floor(c.contest.minDurationSeconds / 5) + 1)})`);
    lines.push("\tFinalize(cross(cur))");
    lines.push("\tv, _ := Ballot()");
    lines.push(`\tuassert.Equal(t, ${turnout}, v.Turnout)`);

    const electorate = 1 + extra + (seatedEntrant ? 1 : 0);
    const quorumMet = !membersOnly || turnout * 100 >= c.contest.quorumPercent * electorate;
    lines.push(`\tuassert.Equal(t, int(core.${quorumMet ? "OutcomeWinner" : "OutcomeNoQuorum"}), int(v.Outcome))`);
    lines.push(`\t${quorumMet ? "w" : "_"}, ok := Winner()`);
    lines.push(`\tuassert.Equal(t, ${gnoBool(quorumMet)}, ok)`);
    if (quorumMet) {
      lines.push("\tuassert.Equal(t, uint64(2), w)");
      // Render escapes the label, so ")" appears as "\)".
      lines.push(`\tuassert.True(t, strings.Contains(Render(""), ${gnoString("(entry 2\\)")}))`);
    }
  };
  scenario();

  const usesStrings = lines.some((l) => l.includes("strings."));
  const usesCore = lines.some((l) => l.includes("core."));
  return `package ${packageName(spec)}

${imports(lock, usesCore ? ["core"] : [], usesStrings ? ["strings", "testing"] : ["testing"], ["gno.land/p/nt/testutils/v0", "gno.land/p/nt/uassert/v0"])}

// Generated from the project configuration; regenerate rather than edit.

var (
	scnOwner    = testutils.TestAddress("scn-owner")
	scnAlice    = testutils.TestAddress("scn-alice")
	scnBob      = testutils.TestAddress("scn-bob")
	scnEntrant1 = testutils.TestAddress("scn-entrant1")
	scnEntrant2 = testutils.TestAddress("scn-entrant2")
	scnMallory  = testutils.TestAddress("scn-mallory")
)

func TestGeneratedScenario(cur realm, t *testing.T) {
${lines.join("\n")}
}
`;
}

function gnoArgs(xs: string[]): string {
  return xs.map(gnoString).join(", ");
}
