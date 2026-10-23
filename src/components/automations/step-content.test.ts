import { describe, expect, it } from "vitest"

import { stepNeedsDeleteConfirm } from "./step-content"

describe("stepNeedsDeleteConfirm", () => {
  it("skips the prompt for an untouched step", () => {
    expect(
      stepNeedsDeleteConfirm({ step_config: { amount: 1, unit: "hours" } }, { unit: "hours", amount: 1 }),
    ).toBe(false)
  })

  it("asks when the config was edited", () => {
    expect(
      stepNeedsDeleteConfirm({ step_config: { text: "Hola" } }, { text: "" }),
    ).toBe(true)
  })

  it("asks when a condition has steps in either branch", () => {
    const blank = { subject: "tag_presence", operand: "", value: "" }
    expect(
      stepNeedsDeleteConfirm({ step_config: { ...blank }, branches: { yes: [], no: [] } }, blank),
    ).toBe(false)
    expect(
      stepNeedsDeleteConfirm({ step_config: { ...blank }, branches: { yes: [], no: [{}] } }, blank),
    ).toBe(true)
  })

  it("compares nested payloads structurally", () => {
    const blank = { kind: "buttons", body: "", buttons: [{ id: "btn_1", title: "" }] }
    expect(
      stepNeedsDeleteConfirm(
        { step_config: { buttons: [{ title: "", id: "btn_1" }], body: "", kind: "buttons" } },
        blank,
      ),
    ).toBe(false)
    expect(
      stepNeedsDeleteConfirm(
        { step_config: { kind: "buttons", body: "", buttons: [{ id: "btn_1", title: "Sí" }] } },
        blank,
      ),
    ).toBe(true)
  })
})
