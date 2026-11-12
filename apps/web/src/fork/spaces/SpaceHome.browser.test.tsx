import type { Space } from "@t3tools/fork-spaces/contracts/space";
import { fixtureSpacesSnapshot } from "@t3tools/fork-spaces/shared/spaceFixtures";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../../components/ui/sidebar";
import { SpaceHome } from "./SpaceHome";

const [payments, , archived] = fixtureSpacesSnapshot.spaces;

async function renderHome(space: Space) {
  const handlers = {
    onUpdate: vi.fn((_changes: { title?: string; brief?: string }) => {}),
    onSetPinned: vi.fn((_pinned: boolean) => {}),
    onArchive: vi.fn(() => {}),
    onUnarchive: vi.fn(() => {}),
    onDelete: vi.fn(() => {}),
  };
  const screen = await render(
    <SidebarProvider defaultOpen>
      <SpaceHome space={space} projectNames={[]} {...handlers} />
    </SidebarProvider>,
  );
  return { screen, handlers };
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
