import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => cleanup());
import { PeopleCombobox, isValidEmail } from "./people-combobox";

const USERS = [
  { id: "u1", email: "alice@example.com", name: "Alice" },
  { id: "u2", email: "bob@example.com", name: "Bob Smith" },
];

const GROUPS = [
  { id: "g1", name: "Writers", slug: "writers" },
  { id: "g2", name: "Reviewers", slug: "reviewers" },
];

function typeInto(input: HTMLElement, value: string): void {
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
}

describe("isValidEmail", () => {
  it("accepts a plain address", () => {
    expect(isValidEmail("alice@example.com")).toBe(true);
  });
  it("rejects whitespace and control chars", () => {
    expect(isValidEmail("alice @example.com")).toBe(false);
    expect(isValidEmail("alice@ex.com\n")).toBe(false);
  });
  it("rejects missing @, missing dot, double @", () => {
    expect(isValidEmail("nope")).toBe(false);
    expect(isValidEmail("nope@example")).toBe(false);
    expect(isValidEmail("a@b@c.com")).toBe(false);
  });
});

describe("PeopleCombobox", () => {
  function setup(overrides: Partial<Parameters<typeof PeopleCombobox>[0]> = {}) {
    const onAddExisting = vi.fn();
    const onInviteEmail = vi.fn();
    const onRoleChange = vi.fn();
    render(
      <PeopleCombobox
        users={USERS}
        groups={GROUPS}
        existing={[]}
        role="viewer"
        onRoleChange={onRoleChange}
        onAddExisting={onAddExisting}
        onInviteEmail={onInviteEmail}
        {...overrides}
      />,
    );
    return { onAddExisting, onInviteEmail, onRoleChange };
  }

  it("filters users by name", () => {
    setup();
    typeInto(screen.getByLabelText("Add people, groups, or invite by email"), "alice");
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.queryByText("Bob Smith")).toBeNull();
  });

  it("filters users by email substring", () => {
    setup();
    typeInto(screen.getByLabelText("Add people, groups, or invite by email"), "bob@");
    expect(screen.getByText("Bob Smith")).toBeTruthy();
    expect(screen.queryByText("Alice")).toBeNull();
  });

  it("filters groups by name", () => {
    setup();
    typeInto(screen.getByLabelText("Add people, groups, or invite by email"), "writ");
    expect(screen.getByText("Writers")).toBeTruthy();
    expect(screen.queryByText("Reviewers")).toBeNull();
  });

  it("shows Invite option only for a valid email with no matching user", () => {
    setup();
    const input = screen.getByLabelText("Add people, groups, or invite by email");

    typeInto(input, "alice@example.com");
    expect(screen.queryByText("Invite alice@example.com")).toBeNull();

    typeInto(input, "carol@example.com");
    expect(screen.getByText("Invite carol@example.com")).toBeTruthy();
  });

  it("calls onAddExisting when picking a user row", () => {
    const { onAddExisting, onInviteEmail } = setup();
    typeInto(screen.getByLabelText("Add people, groups, or invite by email"), "Bob");
    fireEvent.mouseDown(screen.getByText("Bob Smith"));
    expect(onAddExisting).toHaveBeenCalledWith("user", "u2");
    expect(onInviteEmail).not.toHaveBeenCalled();
  });

  it("calls onInviteEmail when picking the Invite row", () => {
    const { onAddExisting, onInviteEmail } = setup();
    typeInto(screen.getByLabelText("Add people, groups, or invite by email"), "carol@example.com");
    fireEvent.mouseDown(screen.getByText("Invite carol@example.com"));
    expect(onInviteEmail).toHaveBeenCalledWith("carol@example.com");
    expect(onAddExisting).not.toHaveBeenCalled();
  });

  it("hides users already in the existing list", () => {
    setup({ existing: [{ subjectType: "user", subjectId: "u1" }] });
    typeInto(screen.getByLabelText("Add people, groups, or invite by email"), "alice");
    expect(screen.queryByText("Alice")).toBeNull();
  });
});
