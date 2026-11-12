import type { Link, LinkReference, Nodes, Root } from "mdast";

/** Agents write briefs, so an image in one could be a tracking pixel: show it as a link. */
function imageToLink(node: Nodes): Nodes {
  if (node.type === "image") {
    const link: Link = {
      type: "link",
      url: node.url,
      title: node.title ?? null,
      children: [{ type: "text", value: node.alt || node.url }],
    };
    return link;
  }
  if (node.type === "imageReference") {
    const link: LinkReference = {
      type: "linkReference",
      identifier: node.identifier,
      label: node.label ?? null,
      referenceType: node.referenceType,
      children: [{ type: "text", value: node.alt || node.label || node.identifier }],
    };
    return link;
  }
  if ("children" in node) {
    (node as { children: Nodes[] }).children = node.children.map(imageToLink);
  }
  return node;
}

function remarkImagesAsLinks() {
  return (tree: Root) => {
    imageToLink(tree);
  };
}

/** A module constant: ChatMarkdown keys its parse cache on this list. */
export const BRIEF_REMARK_PLUGINS = [remarkImagesAsLinks];
