import { describe, expect, test } from "bun:test"
import type { RepoName } from "../refs"
import { closingLine, splitClosingBlock, withClosing } from "./closes"

const repo = (full: string): RepoName => {
  const [owner = "", name = ""] = full.split("/")
  return { owner, name, full }
}

const PR_REPO = repo("octo/hello")
const issue = (number: number, full = "octo/hello") => ({ repo: repo(full), number })

describe("closingLine", () => {
  test("is short within the pull request's repository, whatever the case", () => {
    expect(closingLine(issue(12), PR_REPO)).toBe("Closes #12")
    expect(closingLine(issue(12, "Octo/Hello"), PR_REPO)).toBe("Closes #12")
  })

  test("names the repository for an issue of another one", () => {
    expect(closingLine(issue(7, "other/thing"), PR_REPO)).toBe("Closes other/thing#7")
  })
})

describe("adding", () => {
  test("a line after the body, set off by a blank line", () => {
    expect(withClosing("Adds the thing.", [issue(12)], [], PR_REPO)).toBe("Adds the thing.\n\nCloses #12")
  })

  test("trailing whitespace of the body is dropped first", () => {
    expect(withClosing("Adds the thing.\n\n  \n", [issue(12)], [], PR_REPO)).toBe("Adds the thing.\n\nCloses #12")
  })

  test("an empty body is the line alone", () => {
    expect(withClosing("", [issue(12)], [], PR_REPO)).toBe("Closes #12")
    expect(withClosing(" \n", [issue(12)], [], PR_REPO)).toBe("Closes #12")
  })

  test("several issues stay one per line", () => {
    expect(withClosing("Body", [issue(1), issue(2, "other/thing"), issue(3)], [], PR_REPO)).toBe(
      "Body\n\nCloses #1\nCloses other/thing#2\nCloses #3",
    )
  })

  test("a body that ends with a closing line takes the next one directly under it", () => {
    expect(withClosing("Body\n\nFixes #1\n", [issue(2)], [], PR_REPO)).toBe("Body\n\nFixes #1\nCloses #2")
  })

  test("an issue the body closes already is not added again, in any form, keyword or case", () => {
    const body = "Body\n\nfixes: #1\nRESOLVED octo/hello#2\ncloses https://github.com/Octo/Hello/issues/3\n"
    expect(withClosing(body, [issue(1), issue(2), issue(3)], [], PR_REPO)).toBe(body.trimEnd())
    expect(withClosing(body, [issue(4)], [], PR_REPO)).toBe(`${body.trimEnd()}\nCloses #4`)
  })

  test("the same issue twice is added once", () => {
    expect(withClosing("Body", [issue(1), issue(1)], [], PR_REPO)).toBe("Body\n\nCloses #1")
  })

  test("an issue that is only mentioned in prose is still added", () => {
    expect(withClosing("This closes #1 in spirit.", [issue(1)], [], PR_REPO)).toBe(
      "This closes #1 in spirit.\n\nCloses #1",
    )
  })

  test("a same-named issue of another repository is another issue", () => {
    expect(withClosing("Closes #1", [issue(1, "other/thing")], [], PR_REPO)).toBe("Closes #1\nCloses other/thing#1")
  })
})

describe("removing", () => {
  test.each([
    ["a same-repository reference", "Closes #12"],
    ["a qualified reference", "closes octo/hello#12"],
    ["an issue URL", "Closes https://github.com/octo/hello/issues/12"],
    ["any case of the keyword", "FIXED #12"],
    ["a colon after the keyword", "Resolves: #12"],
    ["a name in another case", "Closes Octo/Hello#12"],
    ["surrounding whitespace", "  Fix   #12  "],
  ])("takes out %s", (_name, line) => {
    expect(withClosing(`Body\n\n${line}`, [], [issue(12)], PR_REPO)).toBe("Body")
  })

  test("takes out only the lines of the issues named, and keeps the others", () => {
    const body = "Body\n\nCloses #1\nCloses #2\nFixes other/thing#1\nResolves https://github.com/octo/hello/issues/3"
    expect(withClosing(body, [], [issue(1), issue(3)], PR_REPO)).toBe("Body\n\nCloses #2\nFixes other/thing#1")
  })

  test("takes out a repeated line every time", () => {
    expect(withClosing("Closes #1\nText\nfixes #1", [], [issue(1)], PR_REPO)).toBe("Text")
  })

  test("leaves a mention in prose, a list or with other words", () => {
    const body = "This closes #12 for good.\n- Closes #12\nCloses #12, #13\nSee #12\nCloses #120"
    expect(withClosing(body, [], [issue(12)], PR_REPO)).toBe(body)
  })

  test("does not take a reference to the same number in another repository", () => {
    expect(withClosing("Closes other/thing#12", [], [issue(12)], PR_REPO)).toBe("Closes other/thing#12")
  })

  test("a qualified issue of the pull request's repository matches the short line", () => {
    expect(withClosing("Body\nCloses #5", [], [issue(5, "OCTO/hello")], PR_REPO)).toBe("Body")
  })

  test("removes, then adds", () => {
    expect(withClosing("Body\n\nCloses #1", [issue(2)], [issue(1)], PR_REPO)).toBe("Body\n\nCloses #2")
  })
})

describe("blank lines around a removal", () => {
  test("a removal that would leave two blank lines in a row keeps one", () => {
    expect(withClosing("A probe.\n\nCloses #2\n\nMore text.", [], [issue(2)], PR_REPO)).toBe("A probe.\n\nMore text.")
    expect(withClosing("A probe.\n\n\nCloses #2\n\n\nMore text.", [], [issue(2)], PR_REPO)).toBe(
      "A probe.\n\nMore text.",
    )
  })

  test("a removal with text directly on one side leaves the single blank line it had", () => {
    expect(withClosing("A probe.\nCloses #2\n\nMore text.", [], [issue(2)], PR_REPO)).toBe("A probe.\n\nMore text.")
    expect(withClosing("A probe.\n\nCloses #2\nMore text.", [], [issue(2)], PR_REPO)).toBe("A probe.\n\nMore text.")
  })

  test("blank lines elsewhere in the body stay, with a removal or without", () => {
    const body = "One.\n\n\n\nTwo.\n\nCloses #2\n\n\n\nThree."
    expect(withClosing(body, [], [issue(2)], PR_REPO)).toBe("One.\n\n\n\nTwo.\n\nThree.")
    expect(withClosing("One.\n\n\n\nTwo.", [issue(1)], [], PR_REPO)).toBe("One.\n\n\n\nTwo.\n\nCloses #1")
    expect(withClosing("One.\n\n\n\nTwo.\nCloses #2", [], [issue(3)], PR_REPO)).toBe("One.\n\n\n\nTwo.\nCloses #2")
  })

  test("a line of whitespace counts as blank", () => {
    expect(withClosing("A.\n \nCloses #2\n\t\nB.", [], [issue(2)], PR_REPO)).toBe("A.\n \nB.")
  })

  test("several removals in a row leave one blank line", () => {
    expect(withClosing("A.\n\nCloses #1\n\nCloses #2\n\nB.", [], [issue(1), issue(2)], PR_REPO)).toBe("A.\n\nB.")
  })

  test("the body's closing lines at the end go with their gap", () => {
    expect(withClosing("A probe.\n\nMore text.\n\nCloses #2", [issue(3)], [issue(2)], PR_REPO)).toBe(
      "A probe.\n\nMore text.\n\nCloses #3",
    )
  })
})

describe("splitClosingBlock", () => {
  test("splits the closing lines the body ends with from its text", () => {
    expect(splitClosingBlock("A probe.\n\nCloses #1\nFixes other/thing#2\n", PR_REPO)).toEqual({
      text: "A probe.",
      block: "Closes #1\nFixes other/thing#2",
    })
  })

  test("a body that does not end with a closing line has no block", () => {
    expect(splitClosingBlock("A probe.\n\nCloses #1\n\nMore.\n\n", PR_REPO)).toEqual({
      text: "A probe.\n\nCloses #1\n\nMore.",
      block: "",
    })
    expect(splitClosingBlock("Closes #1 and more", PR_REPO)).toEqual({ text: "Closes #1 and more", block: "" })
    expect(splitClosingBlock("", PR_REPO)).toEqual({ text: "", block: "" })
  })

  test("a blank line ends the block: only the run at the very end counts", () => {
    expect(splitClosingBlock("Closes #1\n\nCloses #2", PR_REPO)).toEqual({ text: "Closes #1", block: "Closes #2" })
  })

  test("a body of closing lines only is all block", () => {
    expect(splitClosingBlock("Closes #1\nfixes https://github.com/octo/hello/issues/2", PR_REPO)).toEqual({
      text: "",
      block: "Closes #1\nfixes https://github.com/octo/hello/issues/2",
    })
  })

  test("a line that mentions an issue in prose or with other words is text", () => {
    expect(splitClosingBlock("Text\nCloses #1, #2", PR_REPO)).toEqual({ text: "Text\nCloses #1, #2", block: "" })
    expect(splitClosingBlock("Text\n- Closes #1", PR_REPO)).toEqual({ text: "Text\n- Closes #1", block: "" })
  })

  test("the lines of the block are kept as they were", () => {
    expect(splitClosingBlock("Text\n\n  RESOLVED: octo/hello#3  ", PR_REPO)).toEqual({
      text: "Text",
      block: "  RESOLVED: octo/hello#3",
    })
  })
})
