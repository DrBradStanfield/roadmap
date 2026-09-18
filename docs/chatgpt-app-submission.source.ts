/**
 * The PROSE behind the ChatGPT app submission. Data only: no tool names, no
 * annotations, no descriptions are written here, because those live in
 * `packages/health-core/src/mcp-tools.ts` and are read from it.
 *
 * Two artefacts are generated from this file plus MCP_TOOLS and MCP_PROMPTS:
 * `docs/chatgpt-app-submission.json` (the optional upload the OpenAI form
 * takes) and `docs/guides/chatgpt-app.md` (the public page). Build both with
 * `npx tsx scripts/build-chatgpt-app-submission.ts`;
 * `build-chatgpt-app-submission.test.ts` fails if either file drifts from this
 * source or from the tool definitions.
 *
 * Credentials are never written here. The reviewer account's address and
 * password live in the OpenAI form and nowhere in this repository.
 */
import type { McpToolName } from '../packages/health-core/src/product-events';

/** The form's own dropdown has Healthcare; the JSON's enum has no health member (see docs/chatgpt-app-listing.md). */
export const APP_INFO = {
  display_name: 'Health by Dr Brad',
  subtitle: 'Track labs in your own cloud',
  description:
    'Health by Dr Brad keeps your health record as a single file in your own Dropbox or Google Drive. '
    + 'ChatGPT can read it, add measurements and lab results, correct a value entered wrongly, file the '
    + 'results from a lab report dropped into the chat, and compute a plan: what screening is due, and '
    + 'evidence-based suggestions with the citation behind each one. Nothing is stored on our servers, and '
    + 'no value is ever deleted; a correction appends the new number and marks the old row entered-in-error.',
  category: 'LIFESTYLE',
} as const;

export interface ToolProse {
  /** One sentence each, as the portal's three justification fields want them. */
  readOnly: string;
  openWorld: string;
  destructive: string;
  /** For the public page: what the tool does, and the line a reader most wants. */
  does: string;
  never: string;
}

export const TOOL_PROSE: Record<McpToolName, ToolProse> = {
  read_record: {
    readOnly: "Fetches the user's own record file, filters it and returns rows without writing anything back.",
    openWorld: "Reads only the calling user's own file in that user's own Dropbox or Google Drive, over that user's own credential.",
    destructive: 'Writes nothing, so no value can be lost.',
    does: 'Reads your file and returns what it holds: your profile, your measurements, your lab results, your medications and supplements, the screenings you have recorded, and the documents you have filed.',
    never: 'It writes nothing, and it never returns your reminder token.',
  },
  get_plan: {
    readOnly: 'Computes what is due and which suggestions apply from the record held in memory and returns them, adding or changing no row.',
    openWorld: "Computes from the calling user's own file and our own evidence tables, and reaches nothing else.",
    destructive: 'Modifies no row: it is a computation over a record it only reads.',
    does: 'Works out the same plan the website shows: your current values, what screening is due at your age, and suggestions with the reason and the citation behind each one.',
    never: 'It changes nothing, and it is educational information, not medical advice.',
  },
  add_measurement: {
    readOnly: "Appends one measurement row and writes the file back to the user's own cloud.",
    openWorld: "Writes only to the calling user's own file, over that user's own credential.",
    destructive: 'Appends only: no row is deleted or overwritten, and a second value on a day that already holds one is refused.',
    does: 'Adds one value you state, such as a weight or a blood pressure, on the day you say it was taken.',
    never: 'It never overwrites. A second value for the same thing on the same day is refused, and you are sent to a correction instead.',
  },
  add_lab_values: {
    readOnly: "Appends up to 50 lab rows in one call and writes the file back to the user's own cloud.",
    openWorld: "Writes only to the calling user's own file, over that user's own credential.",
    destructive: 'Append-only and all rows or none: existing rows are never deleted, and a duplicate test on the same day is refused.',
    does: 'Adds a whole blood panel in one go, up to 50 tests, each with the unit the lab printed and the date it was taken.',
    never: 'It never replaces a result you already hold, and it files all the rows or none of them.',
  },
  correct_value: {
    readOnly: 'Appends the corrected row, flips the row it supersedes and writes the file back.',
    openWorld: "Touches only the calling user's own file in that user's own cloud.",
    destructive: 'It deletes nothing, but the superseded row is marked entered-in-error permanently, guarded by a required expected value and a 90-day age limit.',
    does: 'Fixes a number that went in wrong. The new value is added at the original date and the old row is marked entered-in-error.',
    never: 'It deletes nothing, it cannot be undone, and it refuses unless the value it is told to expect is the value it finds.',
  },
  update_profile: {
    readOnly: "Writes sex, birth year, birth month or height into the record's profile and saves the file.",
    openWorld: "Writes only to the calling user's own file, over that user's own credential.",
    destructive: 'The profile is last-writer-wins, so a change overwrites what stood there; each changed field requires the value the caller expects to find, and a mismatch writes nothing.',
    does: 'Changes the four things your plan is worked out from: your sex, your birth year, your birth month and your height.',
    never: 'It touches no result. Changing a field you already hold requires the value it expects to find, so a wrong guess writes nothing.',
  },
  report_feedback: {
    readOnly: "Files a public GitHub issue on the project's repository for the user.",
    openWorld: "It posts to GitHub's API on our own repository, carrying only what the assistant wrote about the problem; anything that reads as a health value, an email address, a phone number, a file name or a link carrying a token is refused before it is sent.",
    destructive: 'It creates an issue and takes nothing away; the health record is neither read nor changed.',
    does: 'Reports a problem for you, as a public issue on the project, when something refuses or looks wrong.',
    never: 'It opens no health record. It refuses anything that reads as a health value, an email address, a phone number, a file name or a link carrying a token, and it shows you the report before you say yes; the report carries only what the assistant wrote about the problem.',
  },
  import_documents: {
    readOnly: "Its extract phase parks candidate values in the user's own folder and its commit phase appends values and files documents.",
    openWorld: "It sends a file from the user's own connected Dropbox folder, never the record, to Anthropic's API for extraction, and keeps nothing after extraction.",
    destructive: 'A replace in commit marks the superseded row entered-in-error permanently, guarded by the expected value, a 90-day age limit and the user’s own confirmation.',
    does: 'Reads the lab files sitting in your own connected Dropbox folder and shows you every value it found against what your record already holds.',
    never: 'It changes nothing in your record until you say yes; the values it found wait in a small file in your own folder until then. It works on Dropbox only: on Google Drive the permission we ask for cannot list a folder, and it says so.',
  },
  file_results: {
    readOnly: "Appends the lab values the user confirmed and files the document as a metadata-only row in the user's own file.",
    openWorld: 'ChatGPT read the attached file, so the call carries only the values it read and reaches nothing outside the user’s own record.',
    destructive: 'A replace flips the superseded row to entered-in-error permanently, guarded by the expected value, a 90-day age limit and the user’s own confirmation.',
    does: 'Files the results from a report you drop into the chat. ChatGPT reads the file itself and sends us only the values it read, checked against our own catalogue, units and ranges.',
    never: 'The file never reaches our server, and the document is filed by name and date only, never its contents.',
  },
};

export interface SubmissionTestCase {
  description: string;
  user_prompt: string;
  tools_triggered: string | null;
  expected_output: string;
}

/** Exactly five, as the form takes. */
export const TEST_CASES: SubmissionTestCase[] = [
  {
    description: 'Read the connected record, the first thing after sign-in.',
    user_prompt: "What's in my health record?",
    tools_triggered: 'read_record',
    expected_output:
      'Returns the profile, seeded measurements and lab results, and empty sections for medications, supplements, screenings and documents. Nothing is written.',
  },
  {
    description: 'Add one measurement the user states in the chat.',
    user_prompt: 'Record my weight today as 78 kg.',
    tools_triggered: 'add_measurement',
    expected_output:
      'Appends one weight row at today’s date and confirms the metric, value and date. A second weight the same day is refused, not overwritten.',
  },
  {
    description: 'Compute the plan from the record.',
    user_prompt: 'What should I do next about my health?',
    tools_triggered: 'get_plan',
    expected_output:
      'Returns current values, what screening is due, and evidence-based suggestions with a reason and citation each, in hedged educational wording. Nothing is written.',
  },
  {
    description:
      'File the results from a lab report dropped into the chat. ChatGPT reads the file itself; it never reaches our server.',
    user_prompt: 'Here is my blood test. Add the results to my record.',
    tools_triggered: 'file_results',
    expected_output:
      'The first call writes nothing and returns each printed result matched against the record, with units and collection date, plus a receipt. After the user confirms in their own words, a second call commits: values appended, document filed as a metadata-only row.',
  },
  {
    description:
      'Correct a value entered wrongly. The record is append-only, so the old row is superseded rather than edited.',
    user_prompt: 'My ferritin should have been 120, not 95.',
    tools_triggered: 'correct_value',
    expected_output:
      'Reads the record for the row id and the value to expect, then returns a confirm receipt naming the seeded ferritin of 95 ug/L and the new value of 120, and writes nothing. After the user’s own yes, a second call appends a ferritin row of 120 at the original date, about 60 days ago and so inside the 90-day window, and marks the 95 row entered-in-error. Nothing is deleted.',
  },
];

/** Prompts the app should not fire on at all. */
export const NEGATIVE_TEST_CASES: SubmissionTestCase[] = [
  {
    description: "Do not trigger for a general medical question that does not touch the user's own record.",
    user_prompt: 'What does high ferritin usually mean?',
    tools_triggered: null,
    expected_output: 'The app should not be invoked. ChatGPT answers from its own knowledge.',
  },
  {
    description: 'Do not trigger for diet planning. The app stores and reads a health record and writes no meal plans.',
    user_prompt: 'Write me a seven-day meal plan for lowering my cholesterol.',
    tools_triggered: null,
    expected_output: 'The app should not be invoked because the request is outside its supported workflows.',
  },
  {
    description: 'Do not trigger for booking or contacting a clinician. The app has no scheduling, directory or messaging.',
    user_prompt: 'Book me an appointment with a doctor near me this week.',
    tools_triggered: null,
    expected_output: 'The app should not be invoked because it cannot book or contact anyone.',
  },
];

/** The public page. `{{tools}}` and `{{prompts}}` are filled from MCP_TOOLS and MCP_PROMPTS. */
export const GUIDE = {
  title: 'Health by Dr Brad in ChatGPT',
  description:
    'What the Health by Dr Brad app does inside ChatGPT, what each of its nine tools can do to your health record, and what it never does.',
  slug: 'chatgpt-app',
  updated: '2026-09-18',
  stories: ['US-32', 'US-36'],
  body: `Your health record is one file, \`health-roadmap.json\`, in your own Dropbox or Google Drive. It is yours. We do not hold a copy, and we have no database of your results.

The Health by Dr Brad app is the bridge between that file and ChatGPT. You authorize it once, against your own cloud account, and ChatGPT can then read your results, work out your plan, add new values and correct an old one. Setting it up takes about five minutes: the steps are in [connecting ChatGPT to your health record](/blogs/guides/connect-chatgpt).

This page is the plain description of what the app can do. It is for anyone deciding whether to connect it, and for anyone reviewing it.

## How your data moves

You connect Dropbox or Google Drive yourself, through that provider's own permission screen, and you can withdraw it there at any time: [dropbox.com/account/connected_apps](https://www.dropbox.com/account/connected_apps) or [myaccount.google.com/connections](https://myaccount.google.com/connections).

To answer one request, our server fetches your file using your own credential, holds it in memory for that request, and writes it back if you asked for a change. Nothing is kept afterwards. There is no per-user row on our side, no health table, and no copy at rest. Your values never enter our logs, our error reports or our analytics.

One exception, and it is yours to trigger: if you ask the app to import the lab files in your connected Dropbox folder, those files go to Anthropic's API so the text can be read. Your record itself is never sent. We keep none of the files afterwards.

## What it can do

Nine tools. Each one says what it does and what it will not do.

{{tools}}

There is no delete. Nothing in your record can be removed by any tool here. A correction adds the right value and marks the wrong one entered-in-error, so the history stays honest and you can see what was changed.

## Before anything permanent

Three tools change something that cannot be reversed: correcting a value, changing your profile, and filing a bug report. Each takes two calls. The first writes nothing and hands back a receipt saying exactly what would happen. Only after you say yes, in your own words, does the second one act. Filing results from a document works the same way: a receipt first, the write after your yes.

ChatGPT has a setting that skips its own approval prompt for a connector. That setting is not your yes, and our tools say so: they still ask, and they still wait.

Two more things worth knowing. Your record holds one value per test per day, so adding a second one is refused rather than allowed to bury the first. And a correction has to name the value it expects to find, so a stale reading cannot silently fix the wrong row.

## Shortcuts

Ready-made prompts appear in ChatGPT's own menu once the app is connected. Picking one sends the words below, and nothing else.

{{prompts}}

## What it never does

It never deletes a value. It never reads another person's record. It never stores your data on our servers. It never sends your record to a model of ours. A bug report refuses anything that reads as a health value, an email address, a phone number, a file name or a link carrying a token. It never sells anything: there is nothing to buy through the app.

It also cannot do things it is sometimes asked for. It writes no meal plans. It books no appointments. It does not message a doctor. For a general medical question that has nothing to do with your own record, ChatGPT answers on its own and no tool runs.

## Not medical advice

The plan is educational information, worked out from published guidelines and the evidence behind each suggestion, with the citation attached. Its hedged wording is deliberate. It does not replace your doctor, and it is not a diagnosis.

If something looks wrong, ask the app to report it. The issue it files is public, so it shows you the report first and sends only what the assistant wrote about the problem.`,
} as const;
