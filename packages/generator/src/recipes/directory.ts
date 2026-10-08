import { activeOperations, type DirectoryProject } from "@remixlab/spec";
import { gnoInt, gnoPkgPath, gnoString } from "../gno.ts";
import { fieldDoc, fieldLiteral, sampleAnswer } from "./formfields.ts";
import { INVITE_FUNCTIONS, deniedMessage, INVITE_READS, RULE_CONST, alignConsts, descriptor, gnomod, imports, packageName, type RecipeInput } from "./common.ts";

type Input = RecipeInput<DirectoryProject>;

const OP_CONST: Record<string, string> = {
  "members.invite": "opInvite",
  "members.remove": "opRemove",
  "members.set_role": "opSetRole",
  "entry.submit": "opSubmit",
  "entry.review": "opReview",
  "policy.set": "opPolicy",
};

export function directoryFiles(input: Input): Record<string, string> {
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
  const ops = activeOperations(spec, recipe);
  const fields = c.form.fields;
  const titleIndex = fields.findIndex((f) => f.name === c.form.titleField);

  const defines = ops.map(
    (o) => `\tpolicy.Define(${OP_CONST[o.op]!}, ${RULE_CONST[c.rules[o.op]!]}, ${RULE_CONST[o.floor]})`,
  );

  const inviteFns = invitation ? INVITE_FUNCTIONS : "";

  return `// Package ${packageName(spec)} is a Remix Lab "${recipe.id}" app generated
// from a project configuration. Entries are submitted through a fixed form;
// reviewers accept or reject them, and accepted entries are listed publicly.
//
// Every submission is public chain data, including entries that are later
// rejected. Rejected entries are not shown on the rendered pages.
//
// Authority model: every write derives the actor from cur.Previous(), the
// immediate caller. An intermediary realm calling on a user's behalf acts as
// itself and gains none of that user's roles. Block state lives in
// unexported variables and only inert views leave the realm.
package ${packageName(spec)}

${imports(lock, ["core", "forms", "membership", "policies"])}

const (
${alignConsts([
  ["pkgPath", gnoString(gnoPkgPath(spec.app.pkgPath))],
  ["appTitle", gnoString(spec.app.title)],
  ["recipeID", gnoString(recipe.id)],
  ["recipeVersion", gnoString(recipe.version)],
  ["pageSize", "25"],
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

	entries = forms.New(forms.Config{
		MaxSubmissions:  ${gnoInt(c.form.maxSubmissions)},
		MaxPerSubmitter: ${gnoInt(c.form.maxPerSubmitter)},
		MaxPayloadBytes: ${gnoInt(c.form.maxPayloadBytes)},
	}, []forms.Field{
${fields.map(fieldLiteral).join("\n")}
	})
}

// --- Entries ---

// Submit stores an entry for review and returns its ID. Every answer is
// public. Leave optional fields empty.
${fields.map(fieldDoc).join("\n")}
func Submit(cur realm, ${fields.map((f) => `${f.name} string`).join(", ")}) uint64 {
	actor := authorize(cur, opSubmit)
	id, err := entries.Submit(actor, []string{${fields.map((f) => f.name).join(", ")}})
	must(err)
	return id
}

// Accept lists a submitted entry publicly. Review decisions are final.
func Accept(cur realm, id uint64) {
	authorize(cur, opReview)
	must(entries.Review(id, core.SubmissionAccepted))
}

// Reject declines a submitted entry. Review decisions are final.
func Reject(cur realm, id uint64) {
	authorize(cur, opReview)
	must(entries.Review(id, core.SubmissionRejected))
}

// --- Membership ---
${inviteFns}
// Join ${invitation ? "accepts the caller's pending invitation" : "adds the caller as a member"}.
func Join(cur realm) {
	ready()
	must(members.Join(cur.Previous().Address()))
}

// Leave removes the caller from the membership.
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

// Entries pages through accepted entries in submission order.
func Entries(offset, limit int) []core.SubmissionView {
	ready()
	return entries.Submissions(int(core.SubmissionAccepted), offset, clampLimit(limit))
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

// Members pages through members ordered by address.
func Members(offset, limit int) []core.MemberView {
	ready()
	return members.List(offset, clampLimit(limit))
}
${invitation ? INVITE_READS : ""}
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

  return `package ${packageName(spec)}

${imports(lock, ["core", "render"], ["net/url", "strconv", "strings"])}

// Render serves the native pages: overview, accepted entries, a single
// entry, the review queue, members and rules.
func Render(path string) string {
	if members == nil {
		return render.Heading(1, appTitle) + "This app is not initialized.\\n"
	}
	segs, q := render.ParsePath(path)
	switch {
	case len(segs) == 0:
		return renderHome()
	case segs[0] == "entries" && len(segs) == 1:
		return renderList("Entries", "entries", core.SubmissionAccepted, q)
	case segs[0] == "entries" && len(segs) == 2:
		id, err := strconv.ParseUint(segs[1], 10, 64)
		if err != nil {
			return notFound()
		}
		return renderEntry(id)
	case segs[0] == "queue" && len(segs) == 1:
		return renderList("Review queue", "queue", core.SubmissionSubmitted, q)
	case segs[0] == "members" && len(segs) == 1:
		return renderMembers(render.Page(q, render.PageCount(members.Size(), pageSize)))
	case segs[0] == "rules" && len(segs) == 1:
		return renderRules()
	}
	return notFound()
}

func renderHome() string {
	accepted := entries.CountByStatus(core.SubmissionAccepted)
	waiting := entries.CountByStatus(core.SubmissionSubmitted)
	var sb strings.Builder
	sb.WriteString(render.Heading(1, appTitle))
	sb.WriteString("Entries are submitted for review; accepted entries are listed here. Every submission, including rejected ones, is public chain data.\\n\\n")
	sb.WriteString("- " + render.Link("Entries", render.RealmURL(pkgPath, "entries")) + " (" + strconv.Itoa(accepted) + ")\\n")
	sb.WriteString("- " + render.Link("Review queue", render.RealmURL(pkgPath, "queue")) + " (" + strconv.Itoa(waiting) + ")\\n")
	sb.WriteString("- " + render.Link("Members", render.RealmURL(pkgPath, "members")) + " (" + strconv.Itoa(members.Size()) + ")\\n")
	sb.WriteString("- " + render.Link("Rules", render.RealmURL(pkgPath, "rules")) + "\\n\\n")
	sb.WriteString(render.TxLink("Submit an entry", pkgPath, "Submit") + " · " + render.TxLink(${gnoString(joinLabel)}, pkgPath, "Join") + "\\n\\n")
	sb.WriteString(renderTable(entries.Submissions(int(core.SubmissionAccepted), 0, 5), false))
	sb.WriteString("_Recipe " + render.Text(recipeID+"@"+recipeVersion) + ". Membership is address-based; one address is not one person._\\n")
	return sb.String()
}

func renderList(heading, route string, status core.SubmissionStatus, q url.Values) string {
	pages := render.PageCount(entries.CountByStatus(status), pageSize)
	page := render.Page(q, pages)
	list := entries.Submissions(int(status), (page-1)*pageSize, pageSize)
	return render.Heading(1, heading) +
		renderTable(list, status == core.SubmissionSubmitted) +
		render.Pager(pkgPath, route, page, pages)
}

func renderTable(list []core.SubmissionView, reviewActions bool) string {
	if len(list) == 0 {
		return "Nothing here yet.\\n\\n"
	}
	var rows [][]string
	for _, v := range list {
		idStr := strconv.FormatUint(v.ID, 10)
		row := []string{
			render.Link("#"+idStr, render.RealmURL(pkgPath, "entries/"+idStr)),
			render.Text(v.Answers[titleIndex]),
		}
		if reviewActions {
			row = append(row, reviewLinks(idStr))
		}
		rows = append(rows, render.TrustedRow(row...))
	}
	headers := []string{"Entry", "Title"}
	if reviewActions {
		headers = append(headers, "Review")
	}
	return render.Table(headers, rows)
}

func renderEntry(id uint64) string {
	v, ok := entries.Submission(id)
	if !ok {
		return notFound()
	}
	idStr := strconv.FormatUint(id, 10)
	if v.Status == core.SubmissionRejected {
		return render.Heading(1, "Entry #"+idStr) + "This entry was rejected.\\n\\n" +
			render.Link("All entries", render.RealmURL(pkgPath, "entries")) + "\\n"
	}
	var sb strings.Builder
	sb.WriteString(render.Heading(1, v.Answers[titleIndex]))
	sb.WriteString("Status: **" + v.Status.String() + "** · submitted by " + render.Code(v.Submitter.String()) + "\\n\\n")
	var rows [][]string
	for i, f := range entries.Fields() {
		if i != titleIndex && v.Answers[i] != "" {
			rows = append(rows, render.Row(f.Label, v.Answers[i]))
		}
	}
	if len(rows) > 0 {
		sb.WriteString(render.Table([]string{"Field", "Answer"}, rows))
	}
	if v.Status == core.SubmissionSubmitted {
		sb.WriteString("Awaiting review: " + reviewLinks(idStr) + "\\n\\n")
	}
	sb.WriteString(render.Link("All entries", render.RealmURL(pkgPath, "entries")) + "\\n")
	return sb.String()
}

func reviewLinks(idStr string) string {
	return render.TxLink("accept", pkgPath, "Accept", "id", idStr) + " · " +
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
	return render.Heading(1, "Rules") +
		render.Table([]string{"Operation", "Who may", "Most permissive allowed"}, rows) +
		${gnoString(limitsNote(spec))} + "\\n"
}

func notFound() string {
	return render.Heading(1, "Not found") + render.Link("Back to the app", render.RealmURL(pkgPath, "")) + "\\n"
}
`;
}

function limitsNote(spec: DirectoryProject): string {
  const f = spec.config.form;
  const per = f.maxPerSubmitter > 0 ? `, at most ${f.maxPerSubmitter} per address` : "";
  return `Up to ${f.maxSubmissions} pending or accepted submissions${per}. Review decisions are final; rejecting an entry frees its slot.`;
}

/**
 * A scenario test derived from the same configuration: reject a submission
 * missing its title, submit a valid entry, check that an outsider cannot
 * review it, accept it and find it on the public list.
 */
function generatedTest({ spec, lock }: Input): string {
  const c = spec.config;
  const fields = c.form.fields;
  const titleIndex = fields.findIndex((f) => f.name === c.form.titleField);
  const answers = fields.map(sampleAnswer);
  // The sample answers must fit the payload limit or the scenario cannot submit.
  const payload = answers.reduce((n, a) => n + new TextEncoder().encode(a).length, 0);
  const args = (xs: string[]) => xs.map(gnoString).join(", ");
  const submitRule = c.rules["entry.submit"]!;
  const reviewRule = c.rules["entry.review"]!;
  const submitter = submitRule === "public" ? "scnAlice" : "scnOwner";

  const lines: string[] = [];
  const as = (who: string) => lines.push(`\ttesting.SetRealm(testing.NewUserRealm(${who}))`);
  lines.push("\tsetup(scnOwner)");
  lines.push("\tuassert.Equal(t, core.RoleOwner.String(), RoleOf(scnOwner))");
  as(submitter);

  if (submitRule === "nobody") {
    lines.push(`\tuassert.AbortsWithMessage(t, cur, "remix: unauthorized: entry.submit is disabled", func() {`);
    lines.push(`\t\tSubmit(cross(cur), ${args(answers)})`);
    lines.push("\t})");
  } else if (payload > c.form.maxPayloadBytes) {
    lines.push(`\tuassert.AbortsWithMessage(t, cur, "remix: limit exceeded: answers too large", func() {`);
    lines.push(`\t\tSubmit(cross(cur), ${args(answers)})`);
    lines.push("\t})");
  } else {
    const missing = answers.map((a, i) => (i === titleIndex ? "" : a));
    lines.push(`\tuassert.AbortsWithMessage(t, cur, ${gnoString(`remix: invalid input: ${c.form.titleField} is required`)}, func() {`);
    lines.push(`\t\tSubmit(cross(cur), ${args(missing)})`);
    lines.push("\t})");
    lines.push(`\tid := Submit(cross(cur), ${args(answers)})`);
    lines.push("\tuassert.Equal(t, 1, len(Queue(0, 25)))");
    lines.push("\tuassert.Equal(t, 0, len(Entries(0, 25)))");

    as("scnMallory");
    lines.push(`\tuassert.AbortsWithMessage(t, cur, ${gnoString(deniedMessage("entry.review", reviewRule))}, func() {`);
    lines.push("\t\tAccept(cross(cur), id)");
    lines.push("\t})");

    if (reviewRule !== "nobody") {
      as("scnOwner");
      lines.push("\tAccept(cross(cur), id)");
      lines.push("\tv, _ := Entry(id)");
      lines.push("\tuassert.Equal(t, int(core.SubmissionAccepted), int(v.Status))");
      lines.push("\tuassert.Equal(t, 1, len(Entries(0, 25)))");
      lines.push("\tuassert.Equal(t, 0, len(Queue(0, 25)))");
      // The accepted entry's table cell (sample answers need no escaping).
      lines.push(`\tuassert.True(t, strings.Contains(Render("entries"), ${gnoString(` | ${answers[titleIndex]!} |`)}))`);
      lines.push(`\tuassert.AbortsWithMessage(t, cur, "remix: invalid state: submission already reviewed", func() {`);
      lines.push("\t\tReject(cross(cur), id)");
      lines.push("\t})");
    }
  }

  const usesStrings = lines.some((l) => l.includes("strings."));
  return `package ${packageName(spec)}

${imports(lock, ["core"], usesStrings ? ["strings", "testing"] : ["testing"], ["gno.land/p/nt/testutils/v0", "gno.land/p/nt/uassert/v0"])}

// Generated from the project configuration; regenerate rather than edit.

var (
	scnOwner   = testutils.TestAddress("scn-owner")
	scnAlice   = testutils.TestAddress("scn-alice")
	scnMallory = testutils.TestAddress("scn-mallory")
)

func TestGeneratedScenario(cur realm, t *testing.T) {
${lines.join("\n")}
}
`;
}
