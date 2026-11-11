---
name: github-planning
description: "Use when turning a requirement into a plan on GitHub, or changing a plan that is already there: decide whether the work is one issue or a parent issue with sub-issues, size each sub-issue as a goal that delivers on its own, include the steps that happen outside the repository (an approval, a contract, a vendor's answer, a manual setup), order them with blocked-by, date them with a milestone or a board's Start and Target, write each body in its form, keep the parts not yet decided as board drafts, and file it all. Also when a plan changes before or during the work (a new direction, a decision made in a later issue, a unit added, dropped, split or merged): what to rewrite in a body, what to say in a comment, what is a relation. Load it with github-issues, and with github-projects for a board: they say how each tool is called. Not for a single bug report, question or idea, starting or tracking the work (Status updates, closing finished issues), or branches and pull requests."
metadata:
  toolset: issues
---

# Planning work on GitHub

A plan on GitHub is a set of issues, the relations between them and, where a
team uses one, their items on a project board. This skill says how to shape a
plan, which form each part takes, how to file it and how to change it later,
so that a person or a later session can start the work from GitHub alone,
without the conversation that produced the plan.

It uses the `github_issue_…` tools and, for a board, the `github_project_…`
tools. How each tool is called, how an issue or a board is named and what a
failure means are in the skills `github-issues` and `github-projects`: read
them before the first call. Some hosts show a tool or a skill under a longer
name (a server or plugin prefix before it).

Planning stops where the work starts. Starting a unit, opening its pull
requests, moving its Status as it advances and closing it when it is done are
not part of this skill.

## What carries what

GitHub's relations carry a plan's structure, and a body does not repeat them:
text goes stale, a relation does not. The one exception is the parent's
`## Plan`, which names its sub-issues to say what each one delivers.

| The plan must say                   | It lives in                                                                    | Not in                                  |
| ----------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| a unit of work                      | an issue                                                                       | a checklist line in another issue       |
| a requirement made of several units | a parent issue with sub-issues                                                 | a label, a `Parent: #n` line            |
| the order between units             | blocked by, on the later issue                                                 | a numbered list, a phase in a title     |
| which release                       | a milestone                                                                    | a date in a title                       |
| when                                | the board's Start and Target, or the organization's Start date and Target date | a date in an issue's body               |
| what sort of work                   | the kind, as the repository's issues use it                                    | a prefix in the title                   |
| how far along                       | Status on the board, the parent's sub-issue progress, the issue's state        | a percentage or a status line in a body |
| work nobody has decided to do yet   | a draft on the board                                                           | an issue nobody will pick up            |

## Choosing the shape

Start from the smallest shape that fits:

1. **One unit of work is one issue with no parent.** Most work is this.
2. **Several units are a parent issue with one sub-issue each.**
3. **Work that is not decided, or has no repository yet, is a draft** on the
   board (see "The board").

A unit is the smallest goal that delivers something on its own. One pull
request implements it, or a few that land together. Delivered means complete
and checkable, not necessarily switched on: a feature that waits for a
signature before it is turned on is done when it works. Test each candidate:

- **It is too small** when its title names a file, a layer or a step instead
  of an outcome ("Add the schema"), or when merging it alone would leave
  something half-built on the default branch. Such a piece is a pull request
  inside a unit: it becomes a line of that unit's implementation outline.
- **It is too big** when its acceptance cannot be checked as one list in one
  sitting, when its parts need an order or dates of their own, or when one
  part should reach users before the rest. It is a parent, or two units.

Never file an issue per pull request. The pull request holds the diff, the
checks and the review beside its slice of the work, so an issue next to it
says the same thing twice.

A plan has two tiers by default: the parent, and units under it. Every leaf
is a unit. Add a tier between them only when a sub-issue itself splits into
several goals that each deliver alone. A parent tracks: it has no branch and
no outline. A requirement that must land in one piece is one unit, not a
parent.

Blocked by means the later unit cannot start. When a unit can go ahead and
only its last part waits (the switch-on waits for a signature), do not block
the unit: make that part a step of its own.

GitHub allows 100 sub-issues per parent, eight levels deep, and a parent and
its sub-issues must belong to the same owner. A milestone belongs to one
repository: a sub-issue in another repository takes a milestone of the same
title there.

## Steps outside the repository

While splitting a requirement, ask what has to happen outside the repository
before it is done: an approval, a signed contract, an answer from a vendor, a
key someone issues, a setting changed by hand, an announcement. A plan that
lists only code looks finished while the release still waits on one of these.

- **A step the requirement depends on is a sub-issue beside the code units**,
  with the kind the repository uses for a task. Only an issue can block
  another: a unit blocked by the step waits visibly, and starts as Waiting on
  a board that has that Status.
- **Only steps the parent's acceptance depends on belong in the plan.** The
  team's other errands do not.
- **It ends when a person closes it with evidence**, not when a pull request
  merges. You plan and file such a step; you neither carry it out nor decide
  that it happened.
- **The assignee is the person who does it or chases it.** Someone outside
  GitHub cannot be assigned, so the body names who is waited on. Assign only
  people the user named, since an assignment notifies them; with nobody
  named, file it unassigned and say so in the report.
- **Plan the slow ones first.** A step with a lead time is filed before the
  others and, where there is a board, goes on it with a Target. Filing starts
  nothing: say in the report which steps someone has to start now.
- **Keep secrets and private terms out.** Never write a secret's value, where
  it is kept, a contract's terms or price, or what someone said in private
  into an issue or a board: a repository or a board can be made public later.
  Link to where the team keeps that detail.

## The board

A board is optional: a plan is complete as issues and relations. One board
shows many requirements side by side, so never make a board per requirement.
A board holds no specification and no acceptance; the parent issue does.

- **On the board**: parent issues and issues with no parent; a sub-issue when
  its own date or Status matters, as a step with a lead time does; drafts.
  Never pull-request-sized slices.
- **Which board**: `github_project_read` with `method: "view"` finds it and
  reports the `route`. A board found through the organization or the viewer
  for a repository the user does not own may be shared or personal: ask
  before filing there. When no board is found, ask whether the plan needs
  one; do not create one unasked.
- **Dates**: a release is a milestone. A schedule is the board's Start and
  Target, set with `fields`. Where the board's date columns mirror the
  organization's issue fields (`issue_field: true` in `view`), the dates are
  the issue's own and are set with `issue_fields` (`Start date`,
  `Target date`). Target is the day the work has to be done by; for an
  outside step, the day its answer is needed. Never work a date out from a
  lead time yourself: ask for it, and leave it unset until someone gives one.
- **Draft or issue**: keep an item a draft while it is undecided whether it
  will be done, or while it has no repository to live in. Turn it into an
  issue with `github_project_item_convert` (never a new issue beside it) once
  it needs a pull request, an assignee or a discussion, or has grown parts
  worth sub-issues. Then write its body in the issue form, make its `After`
  lines blocked-by relations and move its notes into comments.

## Forms

The four parts of a plan hold different things, so each has its own form.

### Titles

An action phrase that states the work, in the repository's language: "Retry
the upload once on a 5xx", not "Upload retries" and not a bare symptom. The
detail goes in the body.

### A draft

A draft has no relations and no comments, so its body carries the order and
the history that an issue keeps elsewhere.

```markdown
Two customers asked for a nightly copy of their notes, and support exports
them by hand today.

**Source**: [call notes with the support team, 2026-11-10](https://example.com/notes/1110)
**After**: Let people export every note in one file
**Together with**: Renew the storage contract

### Notes

- 2026-11-11: sales confirmed both requests
```

`Notes` comes last, so a dated line can be added with `append_body`. A
mention in a draft notifies nobody.

### A parent issue

- `## Overview`: the outcome and why, in one to three lines.
- `## Details`: constraints, principles and the business decisions still
  open, each with where it will be settled. Long research goes in comments on
  the parent; this section keeps what the units must respect.
- `## Plan`: every sub-issue still in the plan as `- #n`, with one line on
  what it delivers, which the sub-issue panel does not say. A finished one
  stays in the list; a dropped one leaves it. No checkboxes: the panel shows
  progress. The list gives no order; blocked-by does.
- `## Acceptance`: the checks run after every sub-issue is done, as `- [ ]`.
  Never "all sub-issues closed", which says nothing the panel does not.

### A unit that code delivers

A sub-issue, or an issue with no parent.

- `## Purpose`: the single goal, in one or two lines.
- `## Requirements`: what must hold, as bullets.
- `## Research` (when there is any): the facts the requirements rest on, each
  with its source. Copy in what the unit relies on from the parent's
  research, so the unit reads on its own after the parent closes.
- `## Implementation outline`: the pull requests expected, as prose bullets,
  each saying what it delivers. This list, not a set of issues, is how a unit
  splits, so changing the split is a text edit.
- `## Open decisions`: what must be settled before the unit starts. They are
  left open at planning on purpose: a later unit's boundaries depend on how
  the earlier ones turn out. Leave the section out when nothing is open.
- `## Acceptance`: the checks that say it is done, as `- [ ]`.

### A step outside the repository

```markdown
## Purpose

Exports of large accounts fit in the vendor's storage.

## Steps

- [ ] Send the limit increase request through the vendor's form
- [ ] Answer the questions of the vendor's review

**Waiting on**: the vendor's account team, who answer within ten business days

## Acceptance

- [ ] The storage console shows the new limit on the production account
```

It has no outline and no open decisions: something not yet known about the
step is its first line ("Find out what the vendor's review asks for"), and a
decision the business still owes belongs in the parent's `## Details`. When
the step is closed, `## Evidence` says what shows that it happened: a link, a
date, who confirmed. Never the secret itself.

### Rules every body follows

- **A section is fixed by its meaning, not its wording.** Read a recent
  parent and one of its sub-issues first and reuse the words the repository
  already gives each meaning. Where it has none, translate the name once into
  the repository's language and keep that word in every later body.
- **Only the sections that apply.** No empty heading, no "N/A".
- **No relation in text**, the parent's `## Plan` aside. No `Parent: #n`, no
  step numbers, no percentage.
- **An issue's body is the specification as it stands now.** It has no dated
  sections and no struck-out text (see "Changing a plan").
- **Write references GitHub turns into links**: `#12`, `owner/repo#12`, a
  permalink with a commit and a line range for code, and a named link such as
  `[the vendor's reply, 2026-11-20](URL)` for anything else. Never a bare
  URL, and never a path on a machine. A source with no link is named in
  words: who said it, and when. Put a long log in `<details>`. Write `@name`
  only to notify.

## Filing a plan

### 1. Read before writing

- **A twin**: `github_issue_read` with `method: "list"`, `state: "all"` and
  the requirement's key words in `query`. Extend the issue that exists
  instead of filing a second one.
- **The repository's habits**: `view` a recent parent and one of its
  sub-issues. They show the section names, the kinds, the milestone titles,
  who is assigned, and whether the repository has issue fields
  (`issue_fields: null` means it has none).
- **The board**, when the board tools are there: `view` reports the route
  that found it, its Status options (is there a Waiting?) and its date
  fields.

Ask the user only what a read cannot tell: the release, the dates, who does
each outside step, and which board when several match.

### 2. Show the plan and wait

Filing notifies people and cannot be taken back: these tools close an issue,
they never delete one. So show the plan first and wait for a yes.

```text
Parent  Let people export every note in one file       v2.0 · Roadmap, Target 2026-12-15
├ unit  Export every note from the settings page
├ step  Get the storage limit raised by the vendor     @mika · Target 2026-11-28
├ unit  Attach files to the export                     blocked by the vendor step
└ unit  Document the export in the help pages          blocked by the first unit
Draft   Offer scheduled exports                        not decided
```

The tree is what the user agrees to. Show a body with it when the body holds
a choice the user should see, or when asked. Say which choices you made
without asking (a kind, a milestone, a split), so they can be changed before
anything is written.

### 3. File in order

1. **The parent**: `github_issue_create` with its body, `kind`, `milestone`,
   and `project` with `fields` when it goes on a board. Its `## Plan` holds
   the sub-issues' titles for now.
2. **The sub-issues, blockers first**, so every `blocked_by` names an issue
   that exists: `github_issue_create` with `parent`, `blocked_by`,
   `milestone`, `assignees`, and `project` with `fields` for those that go on
   the board.
3. **The parent again**: `github_issue_edit` with the body whose `## Plan`
   names each sub-issue as `#n`.
4. **Drafts**: `github_project_item_create`.

A milestone that does not exist stops a call before anything is written.
Pass `create_milestone: true` only when the user agreed to a new milestone.

When a result lists `errors`, the issue or draft exists and one later step
failed. **Never create it again.** Fix that step on what exists, with
`github_issue_edit`, `github_issue_relate` or the board tools. When a result
has `foreign: true`, the repository is someone else's: stop and confirm
before filing the rest there.

### 4. Check what was written

- `view` the parent: it has as many sub-issues as the plan.
- `view` each unit that waits on another: its blocked-by lists the blockers.
  `dependencies_error` set means they could not be read, not that there are
  none.
- On a board, `item_list` with `content_repo` shows each item with its Status
  and dates.

Then report the plan as links, what failed and how it was fixed, the choices
made without asking, the outside steps someone has to start now, and anything
only the web UI can do.

### When tools are missing

- **No board tools**: the plan is issues and relations, and every rule above
  about a board is skipped. A release is still a milestone. A date goes in
  the organization's issue fields where it has them; where it has none, the
  day an outside step's answer is expected goes in its `Waiting on` line. An
  undecided idea that would have been a draft is not filed as an issue: tell
  the user about it.
- **No write tools**: do steps 1 and 2, then hand over every part as text in
  its form, ready to file. Say plainly that nothing was filed.
- **A personal account's repository** has no issue fields, so dates live only
  on a board.

## Changing a plan

A plan changes: a direction is dropped before the work starts, a later unit
settles something that reshapes an earlier one. Keep three things apart.

| Place                | Holds                               | Why                                                               |
| -------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| an issue's body      | the specification as it stands now  | whoever opens the issue sees the truth without reading the thread |
| a comment            | what changed and why                | an edit to a body notifies nobody and keeps no reason             |
| relations and fields | order, parentage, release and dates | written in a body, they go stale                                  |

### The order of a change

1. **Find what it touches.** `view` the parent and each open sub-issue, and
   look for lines the change makes untrue: in the units, and in the parent's
   `## Details` and `## Acceptance`.
2. **Say what you will change**: which bodies, which relations, what is filed
   and what closes. When all of it follows from a decision the user stated,
   go on. When you had to choose something they did not say (a unit dropped
   or added, a new split, a date), wait for a yes.
3. **File what is added**, so it has a number.
4. **Rewrite each open unit it touches**, and comment on each (the next two
   sections).
5. **Bring the parent in line**, in one rewrite: its `## Details` and
   `## Acceptance` where they changed, and its `## Plan` lines. Comment on it
   too.
6. **Change the relations and dates** (see "What each change takes").
7. **Close what is dropped.**
8. **Read back** the issues you changed. On a board, move a unit whose last
   blocker went away from Waiting to Todo: the board does not do it. When a
   read-back differs from what you wrote, report it; do not write again
   without finding out why.

The bodies come before the relations, so nobody is unblocked into an outdated
specification.

### Rewriting a body

1. `view` the issue just before the edit and keep the lines you are about to
   replace. `body` replaces the whole text, so a fresh read also keeps what
   someone else added since.
2. `github_issue_edit` with the new `body`, rewritten in place: no "Update"
   section at the end, no struck-out text, no date. Change only the lines the
   change touches; every other line stays as it was.
3. `github_issue_comment` to say what changed (next section).

A fixed typo or a clearer wording needs no comment. A change needs one when
it changes what done means or what someone does next.

### Writing the comment

A comment has no template. Write it as you would tell a teammate.

- **The first sentence says what changed.** A notification and the thread's
  overview show only the start.
- **Quote the lines that were replaced** with `>`, after that sentence. The
  old words are gone from the body, and the quote lets a reader see what
  became what without opening the edit history. Quote only the lines that
  changed. For a section rewritten as a whole, name the section instead, or
  fold the old text in `<details>`. Quote nothing when lines were only added.
- **Then the reason**, and `#n` when another issue caused the change.
- **One comment per issue for one decision**, so a later reader can find it.
  It covers everything the decision changed on that issue, a blocker that
  went away included. A decision that reaches three issues gets a comment on
  each of the three.

```markdown
Attachments over 25 MB are now linked from the export instead of embedded.

> - Attachments are embedded in the export file

#13 settled that the vendor's limit stays at 5 TB, and a large account's
export does not fit under it with its attachments inside. The requirement is
rewritten to say so, and the acceptance check on the file's size is new.
```

### A decision that reaches other issues

- **The reason is told on every issue it changes.** Each gets its own
  comment, which says what changed there and why, and names the issue that
  prompted the decision as `#n`. A reader of one issue should not have to
  find another to learn why it changed.
- **A decision taken in conversation is written out** in those comments, in
  the repository's terms. Nobody can follow a link to a conversation.
- **An issue already closed is not rewritten**: it records what was done.
  When the decision adds work that no open issue covers, that work is a new
  issue under the parent, which refers to the closed one. When you cannot
  tell whether an open issue covers it, ask.
- **Do not rewrite a body the user's side did not write**, such as a
  reporter's issue: propose the change in a comment, and plan in an issue of
  your own that refers to it.

### What each change takes

| The change                        | Do                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| requirements, acceptance or scope | rewrite the body, then comment                                                                                     |
| the order                         | `github_issue_relate` with `add_blocked_by` or `remove_blocked_by`; comment when it changes what someone can start |
| a release or a date               | set the milestone or the date; comment only when someone relies on the old one                                     |
| a unit is added                   | file it under the parent with its blocked-by, and add its line to the parent's `## Plan`                           |
| a unit is dropped                 | `github_issue_close` with `not_planned` and the reason as its `comment`; remove its `## Plan` line                 |
| a decision is still missing       | add it to the unit's `## Open decisions`, then comment                                                             |
| a draft changes                   | `github_project_item_edit` with the rewritten `body` and a dated line under `Notes`                                |

A dropped unit stays a sub-issue of its parent, where the panel shows it
closed as not planned. Look at what it blocked: each of those either no
longer needs it (remove the relation) or needs a replacement. A close that
finds the issue already closed posts no comment; post the reason with
`github_issue_comment`.

### Splitting, merging and re-tiering

Nothing is deleted and no parent is left pointing at nothing.

1. File the successors first, each with what it inherits copied in
   (requirements, research, decisions), so it reads on its own.
2. Comment on each issue being replaced: which issues follow it, and where
   each part of its content went.
3. Take it out of its parent (`github_issue_relate` with `remove_parent`), so
   the panel does not show the same work twice, and close it: `not_planned`
   when it was replaced before its work was done, `completed` when its job
   was done and only carried over.
4. Move its surviving sub-issues to the successors (`github_issue_relate`
   with `parent`), and rewrite the parent's `## Plan`.

## Before you finish

- The shape came from the tests: one unit is one issue, several are a parent
  with sub-issues, and no issue stands for a pull request.
- Every step outside the repository that the acceptance depends on is in the
  plan, blocks what cannot start without it, and names who does it or who is
  waited on.
- Order, parentage, release and dates are relations and fields. No body
  repeats them, the parent's `## Plan` aside.
- Every body you wrote has its form, in the repository's own words, with no
  empty section and no secret.
- The user agreed before the first write.
- After filing, the parent, the blocked units and the board, where there is
  one, were read back and match the plan.
- After a change, each open body says what is true now, and a comment says
  what changed and why, with the replaced lines quoted.
