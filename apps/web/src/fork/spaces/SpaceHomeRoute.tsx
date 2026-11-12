import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { SidebarInset } from "../../components/ui/sidebar";

/** Route content for /spaces/$spaceId; spaces state binds here, and a missing space says so. */
export function SpaceHomeRoute() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>This space isn't available</EmptyTitle>
          <EmptyDescription>
            It may have been deleted, or it is on another machine.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
