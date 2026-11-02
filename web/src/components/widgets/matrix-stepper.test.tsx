import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MatrixWidget, { determinant } from "./MatrixWidget";
import StepperWidget from "./StepperWidget";

describe("determinant", () => {
  it("matches hand-computed values, including pivoting and singular matrices", () => {
    expect(determinant([[2, 0], [0, 3]])).toBe(6);
    expect(determinant([[0, 1], [1, 0]])).toBe(-1);
    expect(determinant([[1, 2], [2, 4]])).toBe(0);
    expect(determinant([[2, -3, 1], [2, 0, -1], [1, 4, 5]])).toBeCloseTo(49);
    expect(determinant([[1, 2, 3]])).toBeNull();
  });
});

describe("MatrixWidget", () => {
  it("recomputes the determinant and the transformed square as an entry changes", () => {
    render(<MatrixWidget spec={{ m: [[1, 0], [0, 1]] }} />);
    expect(screen.getByTestId("det").textContent).toBe("1");
    const before = screen.getByTestId("image-square").getAttribute("points");
    fireEvent.change(screen.getByLabelText("Entry row 1 column 1"), { target: { value: "2" } });
    expect(screen.getByTestId("det").textContent).toBe("2");
    expect(screen.getByTestId("image-square").getAttribute("points")).not.toBe(before);
    fireEvent.change(screen.getByLabelText("Entry row 2 column 2"), { target: { value: "0" } });
    expect(screen.getByText(/collapses/)).toBeTruthy();
  });

  it("shows no picture for a non-2x2 matrix", () => {
    render(<MatrixWidget spec={{ m: [[1, 2, 3], [4, 5, 6]] }} />);
    expect(screen.queryByTestId("image-square")).toBeNull();
    expect(screen.queryByTestId("det")).toBeNull();
  });
});

describe("StepperWidget", () => {
  it("walks forward and back and renders math through KaTeX only", () => {
    const { container } = render(<StepperWidget spec={{ steps: ["Start with $3x + 5 = 20$", "Subtract 5: $3x = 15$", "<img src=x onerror=alert(1)> divide"] }} />);
    expect(screen.getByTestId("step-count").textContent).toBe("Step 1 of 3");
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByTestId("step-count").textContent).toBe("Step 3 of 3");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/<img src=x/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });
});
