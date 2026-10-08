import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const A = "g1lnkytfqcjwllws63gvf0mv9yt04aswy4y9amhm";
const CLUBPOLL = `gno.land/r/${A}/remixlab/clubpoll`;
// A transaction gnokey signed for clubpoll.Vote(1, 1): never what the Lab asks for here.
const SIGNED_VOTE: string = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../../packages/chain/test/fixtures/tx_success.json"), "utf8"),
).response.result.tx;

const errors: string[] = [];
test.beforeEach(({ page }) => {
  errors.length = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
});
test.afterEach(() => expect(errors, "no page errors").toEqual([]));

/** A stand-in for Adena that signs with a fixed, unrelated transaction. */
async function fakeAdena(page: Page, address: string, chainId = "onyx-1") {
  await page.addInitScript(
    ([address, chainId, tx]) => {
      const ok = (data: unknown) => ({ code: 0, status: "success", type: "SUCCESS", message: "", data });
      (window as unknown as { adena: unknown }).adena = {
        AddEstablish: async () => ok({}),
        GetAccount: async () => ok({ address, chainId }),
        GetNetwork: async () => ok({ chainId, networkName: chainId, rpcUrl: "" }),
        AddNetwork: async () => ok({}),
        SwitchNetwork: async () => ok({}),
        SignTx: async () => ok({ encodedTransaction: tx }),
        On: () => true,
      };
    },
    [address, chainId, SIGNED_VOTE] as const,
  );
}

test("home lists the recipes @mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Assemble a Gno app from reviewed parts." })).toBeVisible();
  for (const t of ["Club poll", "Community directory", "Demo contest"]) await expect(page.getByRole("heading", { name: t })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("pages fit a phone screen @mobile", async ({ page }) => {
  for (const url of ["/#/catalog", "/#/recipes/club-poll", `/#/apps/${CLUBPOLL}?net=onyx-1`]) {
    await page.goto(url);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), url).toBeLessThanOrEqual(0);
  }
  await page.goto("/#/recipes/club-poll");
  await page.getByRole("button", { name: "Configure this recipe" }).click();
  await expect(page.getByText("Valid configuration.")).toBeVisible();
  await page.getByRole("tab", { name: /Generated code/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test("catalog filters and a component verifies on Onyx", async ({ page }) => {
  await page.goto("/#/catalog");
  await page.getByLabel("Search").fill("membership.read");
  await expect(page.getByRole("heading", { name: "Membership", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Ballots" })).toHaveCount(0);
  await page.goto("/#/components/core");
  await expect(page.getByRole("button", { name: "core.gno" })).toBeVisible();
  const onyx = page.getByRole("row").filter({ hasText: "Onyx testnet" });
  await onyx.getByRole("button", { name: "Verify on chain" }).click();
  await expect(onyx.getByText("Matches the manifest digest")).toBeVisible();
});

test("compose a club poll: validation, code, changes and export", async ({ page }) => {
  await page.goto("/#/recipes/club-poll");
  await page.getByRole("button", { name: "Configure this recipe" }).click();
  await expect(page).toHaveURL(/#\/compose\/[0-9a-f-]+$/);
  await expect(page.getByText("Valid configuration.")).toBeVisible();

  // A public poll cannot have a percentage quorum.
  await page.getByRole("button", { name: "Any address" }).click();
  await page.getByLabel("Quorum (%)").fill("20");
  await expect(page.getByText("public polls have no fixed electorate")).toBeVisible();
  await page.getByLabel("Quorum (%)").fill("0");
  await expect(page.getByText("Valid configuration.")).toBeVisible();

  // Open joining removes the invitation rule.
  await page.getByRole("button", { name: "Anyone can join" }).click();
  await expect(page.getByText("members.invite")).toHaveCount(0);
  await expect(page.getByText("Valid configuration.")).toBeVisible();

  await page.getByRole("tab", { name: /Generated code/ }).click();
  await expect(page.getByRole("button", { name: "app.gno" })).toBeVisible();
  await page.getByRole("tab", { name: "Changes" }).click();
  await page.getByRole("button", { name: /app\.gno/ }).click();
  await expect(page.locator(".ln.add").first()).toBeVisible();

  await page.getByRole("tab", { name: "Export" }).click();
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project (.zip)" }).click();
  expect((await dl).suggestedFilename()).toBe("clubpoll.zip");

  // Onyx refuses draft components, with the reason.
  await page.locator("main").getByLabel("Network").selectOption("onyx-1");
  await expect(page.getByText("is a draft and cannot be used on onyx-1").first()).toBeVisible();
});

test("a directory form edits fields and reports bad names", async ({ page }) => {
  await page.goto("/#/compose");
  await page.getByRole("button", { name: /Community directory/ }).click();
  await expect(page.getByText("Valid configuration.")).toBeVisible();
  await page.getByLabel("Name").first().fill("must");
  await expect(page.getByText("expected a lowercase identifier that is not a reserved word")).toBeVisible();
});

test("the inspector reads the live club poll on Onyx", async ({ page }) => {
  await page.goto(`/#/apps/${CLUBPOLL}?net=onyx-1`);
  await expect(page.getByText("club-poll@1.0.0")).toBeVisible();
  await expect(page.getByText("No polls yet.").or(page.locator(".option").first())).toBeVisible();
  await page.getByRole("button", { name: "Members" }).click();
  await expect(page.getByText("g1lnkytf…9amhm")).toBeVisible();
  await page.getByRole("button", { name: "Rules" }).click();
  await expect(page.getByText("poll.create")).toBeVisible();

  await page.getByRole("tab", { name: "Native page" }).click();
  await expect(page.locator(".md h1")).toHaveText("Club poll");
  await page.locator(".md a", { hasText: "Members" }).click();
  await expect(page).toHaveURL(/path=members/);
  await expect(page.locator(".md")).toContainText("g1lnky");

  await page.getByRole("tab", { name: "Source" }).click();
  await expect(page.getByText("matches this build")).toBeVisible();
  await page.getByRole("tab", { name: "Composition" }).click();
  await expect(page.getByText("provided by this app itself")).toBeVisible();
});

test("the inspector shows the directory and contest forms from their fields", async ({ page }) => {
  await page.goto(`/#/apps/gno.land/r/${A}/remixlab/directory?net=onyx-1`);
  await expect(page.getByLabel("Project name")).toBeVisible();
  await expect(page.getByLabel(/Year started/)).toBeVisible();
  await page.goto(`/#/apps/gno.land/r/${A}/remixlab/contest?net=onyx-1`);
  await expect(page.getByText("Voting has not opened yet.")).toBeVisible();
  await page.goto(`/#/apps/gno.land/r/${A}/remixlab/sharedmembers?net=onyx-1`);
  await expect(page.getByText("Pending invitations")).toBeVisible();
});

test("a wallet that signs something else is caught before broadcast", async ({ page }) => {
  // The fake wallet is not the maintainer, so open joining is not involved; Join is attempted on an invitation-only app.
  const someone = "g1sw4h2x6rksar4vzpzz2dkm5u9cj4dz6508uud0";
  await fakeAdena(page, someone);
  await page.goto(`/#/apps/gno.land/r/${A}/remixlab/sharedpoll?net=onyx-1`);
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.locator(".topbar").getByText("g1sw4h2x…8uud0")).toBeVisible();
  await page.getByLabel("Title").fill("Lunch");
  await page.getByRole("button", { name: "Create draft poll" }).click();
  await expect(page.getByText(/not broadcast: .*the call differs from the reviewed one/)).toBeVisible();
});

test("the deploy review refuses a path outside the signer's namespace", async ({ page }) => {
  const someone = "g1sw4h2x6rksar4vzpzz2dkm5u9cj4dz6508uud0";
  await fakeAdena(page, someone, "dev");
  await page.goto("/#/compose");
  await page.getByRole("button", { name: /Club poll/ }).click();
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await page.getByRole("button", { name: "Review and deploy" }).click();
  await expect(page.getByText(`Signing as ${someone}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign and deploy" })).toBeDisabled();
});
