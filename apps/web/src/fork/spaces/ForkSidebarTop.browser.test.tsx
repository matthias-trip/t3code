import type { SpaceId } from "@t3tools/fork-spaces/contracts/space";
import { fixtureSpaceIds, fixtureSpacesSnapshot } from "@t3tools/fork-spaces/shared/spaceFixtures";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { SidebarProvider } from "../../components/ui/sidebar";
import { ForkSidebarTop } from "./ForkSidebarTop";

async function renderSwitcher(currentSpaceId: SpaceId | null) {
  const onSelectSpace = vi.fn((_spaceId: SpaceId | null) => {});
  const onNewSpace = vi.fn(() => {});
  const screen = await render(
    <SidebarProvider defaultOpen>
      <ForkSidebarTop
        spaces={fixtureSpacesSnapshot.spaces}
        currentSpaceId={currentSpaceId}
        onSelectSpace={onSelectSpace}
        onNewSpace={onNewSpace}
      />
    </SidebarProvider>,
  );
  return { screen, onSelectSpace, onNewSpace };
}

it("switches space from the keyboard and hands focus back to the switcher", async () => {
  const { screen, onSelectSpace } = await renderSwitcher(null);
  await using _screen = screen;
  const trigger = screen.getByRole("button", { name: /Switch space/ });
  await userEvent.keyboard("{Tab}");
  await expect.element(trigger).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  const options = page.getByRole("menuitemradio");
  await expect.element(options.first()).toHaveFocus();
  // Pinned space first, then the rest; the archived space is not offered.
  expect(options.elements()).toHaveLength(3);
  for (const [index, name] of ["All work", "Payments retry redesign", "Onboarding v3"].entries()) {
    await expect.element(options.nth(index)).toHaveAccessibleName(name);
  }

  await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
  expect(onSelectSpace).toHaveBeenCalledExactlyOnceWith(fixtureSpaceIds.onboarding);
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
});

it("reaches New space from the keyboard and closes without a change on Escape", async () => {
  const { screen, onSelectSpace, onNewSpace } = await renderSwitcher(fixtureSpaceIds.payments);
  await using _screen = screen;
  const trigger = screen.getByRole("button", { name: /Payments retry redesign/ });
  trigger.element().focus();

  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitemradio").first()).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();

  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menuitemradio").first()).toHaveFocus();
  await userEvent.keyboard("{End}{Enter}");
  expect(onNewSpace).toHaveBeenCalledOnce();
  expect(onSelectSpace).not.toHaveBeenCalled();
});
