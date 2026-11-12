import type { Space } from "@t3tools/fork-spaces/contracts/space";
import { fixtureSpacesSnapshot } from "@t3tools/fork-spaces/shared/spaceFixtures";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../../components/ui/sidebar";
import { SpaceHome, type SpaceHomeProps } from "./SpaceHome";

const [payments, onboarding, archived] = fixtureSpacesSnapshot.spaces;

async function renderHome(space: Space, extra: Partial<SpaceHomeProps> = {}) {
  const handlers = {
    onUpdate: vi.fn((_changes: { title?: string; brief?: string }) => {}),
    onSetPinned: vi.fn((_pinned: boolean) => {}),
    onArchive: vi.fn(() => {}),
    onUnarchive: vi.fn(() => {}),
    onDelete: vi.fn(() => {}),
  };
  const ui = (next: Space) => (
    <SidebarProvider defaultOpen>
      <SpaceHome space={next} projectNames={[]} {...handlers} {...extra} />
    </SidebarProvider>
  );
  const screen = await render(ui(space));
  return { screen, handlers, show: (next: Space) => screen.rerender(ui(next)) };
}

it("submits only the edited fields with Enter, refuses a blank title, and Escape discards", async () => {
  const { screen, handlers } = await renderHome(payments!);
  await using _screen = screen;

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const title = screen.getByLabelText("Title");
  await expect.element(title).toHaveFocus();
  await userEvent.clear(title);
  await userEvent.keyboard("   {Enter}");
  await expect.element(screen.getByRole("alert")).toHaveTextContent("A space needs a title.");
  expect(handlers.onUpdate).not.toHaveBeenCalled();

  await userEvent.keyboard("Retry v2{Enter}");
  expect(handlers.onUpdate).toHaveBeenCalledExactlyOnceWith({ title: "Retry v2" });
  await expect.element(screen.getByLabelText("Title")).not.toBeInTheDocument();

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await userEvent.type(screen.getByLabelText("Brief"), " More.");
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByLabelText("Brief")).not.toBeInTheDocument();
  expect(handlers.onUpdate).toHaveBeenCalledOnce();
});

it("deletes an archived space only after the confirmation", async () => {
  const { screen, handlers } = await renderHome(archived!);
  await using _screen = screen;

  await userEvent.click(screen.getByRole("button", { name: "More space actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Delete space…" }));
  const dialog = page.getByRole("alertdialog");
  await expect.element(dialog).toBeVisible();
  await userEvent.click(dialog.getByRole("button", { name: "Cancel" }));
  await expect.element(dialog).not.toBeInTheDocument();
  expect(handlers.onDelete).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole("button", { name: "More space actions" }));
  await userEvent.click(page.getByRole("menuitem", { name: "Delete space…" }));
  await userEvent.click(
    page.getByRole("alertdialog").getByRole("button", { name: "Delete space" }),
  );
  expect(handlers.onDelete).toHaveBeenCalledOnce();
});

it("keeps an IME composition's or an inner control's Escape from discarding the form", async () => {
  const { screen } = await renderHome(payments!);
  await using _screen = screen;

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  const title = screen.getByLabelText("Title");
  title
    .element()
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true }),
    );
  const handled = (event: KeyboardEvent) => {
    if (event.key === "Escape") event.preventDefault();
  };
  window.addEventListener("keydown", handled, { capture: true });
  await userEvent.keyboard("{Escape}");
  window.removeEventListener("keydown", handled, { capture: true });
  await expect.element(title).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await expect.element(title).not.toBeInTheDocument();
});

it("never carries a draft over to another space or past archiving", async () => {
  const { screen, handlers, show } = await renderHome(payments!);
  await using _screen = screen;

  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await userEvent.fill(screen.getByLabelText("Title"), "Draft for payments");
  await show(onboarding!);
  await expect.element(screen.getByLabelText("Title")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("heading", { level: 1 }))
    .toHaveTextContent(onboarding!.title);
  await userEvent.click(screen.getByRole("button", { name: "Edit" }));
  await expect.element(screen.getByLabelText("Title")).toHaveValue(onboarding!.title);

  await show({ ...onboarding!, archivedAt: "2026-11-12T00:00:00.000Z" });
  await show(onboarding!);
  await expect.element(screen.getByLabelText("Title")).not.toBeInTheDocument();
  expect(handlers.onUpdate).not.toHaveBeenCalled();
});

it("moves between section tabs with the arrow keys, Home and End", async () => {
  const { screen } = await renderHome(
    { ...payments!, brief: "Overview text" },
    {
      extraTabs: [
        { value: "sources", label: "Sources", content: "Sources text" },
        { value: "memory", label: "Memory", content: null },
        { value: "reactions", label: "Reactions", content: "Reactions text" },
      ],
    },
  );
  await using _screen = screen;
  const tabs = screen.getByRole("tab");
  expect(tabs.elements()).toHaveLength(3);
  const panel = screen.getByRole("tabpanel");
  await expect.element(panel).toHaveAccessibleName("Overview");
  await expect.element(panel).toHaveTextContent("Overview text");

  await userEvent.click(tabs.first());
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(tabs.nth(1)).toHaveFocus();
  await expect.element(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect.element(screen.getByRole("tabpanel")).toHaveTextContent("Sources text");

  await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
  await expect.element(tabs.nth(2)).toHaveFocus();
  await expect.element(screen.getByRole("tabpanel")).toHaveAccessibleName("Reactions");
  await userEvent.keyboard("{Home}");
  await expect.element(tabs.first()).toHaveFocus();
  await userEvent.keyboard("{End}");
  await expect.element(tabs.nth(2)).toHaveFocus();
  await userEvent.keyboard("{Tab}");
  await expect.element(screen.getByRole("tabpanel")).toHaveFocus();
});

it("shows images in the brief as links and never loads them", async () => {
  const { screen } = await renderHome({
    ...payments!,
    brief: '![pixel](https://t.example/p.gif)\n\n<img src="https://t.example/q.gif" alt="raw">',
  });
  await using _screen = screen;

  await expect.element(screen.getByRole("link", { name: "pixel" })).toBeVisible();
  expect(screen.container.querySelector("img")).toBeNull();
});
