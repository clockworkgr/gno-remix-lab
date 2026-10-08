import { activeOperations, type ProjectSpec, type RecipeManifest, type Rule } from "@remixlab/spec";
import { duration } from "./format.ts";

export const RULE_LABEL: Record<Rule, string> = {
  public: "Anyone",
  member: "Members",
  reviewer: "Reviewers",
  owner: "Owners",
  nobody: "Nobody",
};

/** Who a rule admits, spelled out (roles include the ones above them). */
export function ruleWho(rule: Rule): string {
  switch (rule) {
    case "public":
      return "anyone with an address";
    case "member":
      return "members, reviewers and owners";
    case "reviewer":
      return "reviewers and owners";
    case "owner":
      return "owners only";
    case "nobody":
      return "nobody: the operation is disabled";
  }
}

export interface PermissionLine {
  op: string;
  description: string;
  rule: Rule;
  floor: Rule;
  who: string;
  changedFromDefault: boolean;
}

export function permissionLines(spec: ProjectSpec, recipe: RecipeManifest): PermissionLine[] {
  return activeOperations(spec, recipe).map((o) => {
    const rule = (spec.config.rules[o.op] ?? o.default) as Rule;
    return { op: o.op, description: o.description, rule, floor: o.floor, who: ruleWho(rule), changedFromDefault: rule !== o.default };
  });
}

/** Plain statements about how the app behaves, derived from the configuration. */
export function behaviour(spec: ProjectSpec): string[] {
  const out: string[] = [];
  const m = spec.config.membership;
  out.push(
    m.joinMode === "invitation"
      ? `People join by invitation only, up to ${m.maxMembers} members.`
      : `Anyone may join as a member, up to ${m.maxMembers} members.`,
  );
  out.push("The address that deploys the app becomes its first owner.");
  switch (spec.recipe.id) {
    case "club-poll": {
      const b = (spec as Extract<ProjectSpec, { recipe: { id: "club-poll" } }>).config.ballots;
      out.push(
        b.eligibility === "members"
          ? "Only members may vote. Each poll's electorate is frozen when it opens, so joining later does not grant a vote."
          : "Any address may vote once per poll. One address is not one person.",
      );
      out.push(b.quorumPercent > 0 ? `A poll needs ${b.quorumPercent}% turnout of its electorate to produce a result.` : "Polls have no quorum.");
      out.push(b.allowAbstain ? "Voters may abstain explicitly." : "There is no abstain option.");
      out.push(`Polls last between ${duration(b.minDurationSeconds)} and ${duration(b.maxDurationSeconds)}, with 2 to ${b.maxOptions} options.`);
      out.push(`At most ${b.maxBallots} polls may be in draft or open at once; finished polls stay readable.`);
      break;
    }
    case "community-directory": {
      const f = (spec as Extract<ProjectSpec, { recipe: { id: "community-directory" } }>).config.form;
      out.push(`Submissions have ${f.fields.length} field${f.fields.length === 1 ? "" : "s"}; "${f.titleField}" is shown as each entry's title.`);
      out.push(
        `Up to ${f.maxSubmissions} entries may be pending or accepted at once${f.maxPerSubmitter ? `, at most ${f.maxPerSubmitter} per address` : ""}. Rejecting an entry frees its slot.`,
      );
      out.push("Only accepted entries are listed publicly.");
      break;
    }
    case "demo-contest": {
      const s = spec as Extract<ProjectSpec, { recipe: { id: "demo-contest" } }>;
      const c = s.config.contest;
      out.push(`Up to ${c.maxEntries} accepted entries go on the ballot; voting needs at least two.`);
      out.push(
        c.eligibility === "members"
          ? "Only members may vote, and the electorate is frozen when voting opens."
          : "Any address may vote once. One address is not one person.",
      );
      out.push(c.quorumPercent > 0 ? `The result needs ${c.quorumPercent}% turnout.` : "Voting has no quorum.");
      out.push(`Voting lasts between ${duration(c.minDurationSeconds)} and ${duration(c.maxDurationSeconds)}. A tie has no winner.`);
      break;
    }
  }
  return out;
}
