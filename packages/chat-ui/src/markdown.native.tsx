import { type ColorTokens, darkTokens, type ResolvedAppearance } from "@rakazo/ui-tokens";
import Markdown, {
  type ASTNode,
  createMarkdownIt,
  FitImage,
  MarkdownStream,
  type MarkdownStyleMap,
  type RenderRules,
} from "@ronradtke/react-native-markdown-display";
import type { ReactNode } from "react";
import { memo, useContext, useMemo, useState } from "react";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import {
  inlineMarkdownImageSrc,
  linkifyExplicitUrls,
  markRemoteImageLoaded,
  plainTextLinkParts,
  RemoteImagesContext,
  remoteImageRenders,
  remoteMarkdownImage,
  sanitizeMarkdownUrl,
} from "./markdown";

function keepMarkdownLinkToken(_url: string) {
  return true;
}

// One shared parser: the Markdown components memoize on its identity.
const markdownParser = createMarkdownIt();
markdownParser.validateLink = keepMarkdownLinkToken;
linkifyExplicitUrls(markdownParser);

function markdownStyles(palette: ColorTokens) {
  return StyleSheet.create({
    body: {
      color: palette.foreground,
      fontSize: 15.5,
      lineHeight: 23,
      width: "100%",
      minWidth: 0,
      flexShrink: 1,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 9,
      width: "100%",
      flexShrink: 1,
    },
    heading1: {
      color: palette.foreground,
      fontSize: 21,
      lineHeight: 27,
      marginTop: 10,
      marginBottom: 5,
    },
    heading2: {
      color: palette.foreground,
      fontSize: 19,
      lineHeight: 25,
      marginTop: 10,
      marginBottom: 5,
    },
    heading3: {
      color: palette.foreground,
      fontSize: 17,
      lineHeight: 23,
      marginTop: 8,
      marginBottom: 4,
    },
    strong: {
      color: palette.foreground,
      fontWeight: "700",
    },
    link: {
      color: palette.link,
      textDecorationLine: "underline",
      marginBottom: 0,
    },
    code_inline: {
      color: palette.foreground,
      backgroundColor: palette.background,
      borderColor: palette.border,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 0,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 4,
    },
    code_block: {
      color: palette.foreground,
      backgroundColor: palette.background,
      borderColor: palette.border,
    },
    fence: {
      backgroundColor: palette.background,
      borderColor: palette.border,
    },
    fence_code: {
      backgroundColor: palette.background,
    },
    blockquote: {
      backgroundColor: "transparent",
      borderLeftColor: palette.border,
    },
    table: {
      borderColor: palette.border,
    },
    tr: {
      borderColor: palette.border,
    },
    hr: {
      backgroundColor: palette.border,
    },
    // Custom keys. An image label outside a text node inherits no color, so it carries the body color.
    plain_text: {
      color: palette.foreground,
    },
    // The tap-to-load placeholder for a remote image: a filled, bordered chip that reads as a
    // control on the muted bot bubble in both themes.
    image_placeholder: {
      flexDirection: "row",
      alignItems: "center",
      alignSelf: "flex-start",
      gap: 6,
      minHeight: 32,
      maxWidth: "100%",
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: palette.border,
      backgroundColor: palette.background,
    },
    image_placeholder_icon: {
      width: 14,
      height: 11,
      borderWidth: 1.5,
      borderRadius: 2,
      borderColor: palette.mutedForeground,
    },
    image_placeholder_alt: {
      flexShrink: 1,
      color: palette.foreground,
      fontSize: 14,
    },
    image_placeholder_host: {
      flexShrink: 1,
      color: palette.mutedForeground,
      fontSize: 13,
    },
  });
}

async function openSafeLink(url: string) {
  const safeUrl = sanitizeMarkdownUrl(url);
  if (!safeUrl) return;
  if (await Linking.canOpenURL(safeUrl)) await Linking.openURL(safeUrl);
}

function enclosingLink(parents: readonly ASTNode[]) {
  return parents.find((parent) => parent.type === "link" || parent.type === "blocklink");
}

function textStyleForParents(
  inherited: unknown,
  parents: readonly ASTNode[],
  styleMap: MarkdownStyleMap,
) {
  if (!inherited || typeof inherited !== "object" || Array.isArray(inherited)) return undefined;
  const style = { ...(inherited as Record<string, unknown>) };
  const linkParent = enclosingLink(parents);
  if (!linkParent || sanitizeMarkdownUrl(linkParent.attributes.href ?? "")) return style;
  const linkStyle = StyleSheet.flatten(styleMap.link) ?? {};
  const bodyStyle = StyleSheet.flatten(styleMap.body) ?? {};
  if (style.textDecorationLine === linkStyle.textDecorationLine) delete style.textDecorationLine;
  if (style.color === linkStyle.color) style.color = bodyStyle.color;
  return style;
}

// The library lays table rows out as flex rows of equal-width cells bound to the
// bubble width, so wide tables collapse into unreadable slivers. Give each row a
// minimum width per column and let wide tables scroll horizontally instead.
const TABLE_MIN_COLUMN_WIDTH = 96;

function TableScrollView({
  children,
  style,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  // Percentage widths do not resolve inside a horizontal ScrollView, so the
  // content floor comes from the measured viewport: narrow tables still fill
  // the bubble while wider rows grow the scrollable content.
  const [viewportWidth, setViewportWidth] = useState(0);
  return (
    <ScrollView
      horizontal
      style={style}
      onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}
    >
      <View style={{ minWidth: viewportWidth }}>{children}</View>
    </ScrollView>
  );
}

type RenderRule = NonNullable<RenderRules["link"]>;

// Automatic basis: `flex: 1` is zero-width and collapses a shrink-wrapped list bubble.
function listItemRule(
  node: Parameters<RenderRule>[0],
  children: ReactNode[],
  parent: Parameters<RenderRule>[2],
  styleMap: Parameters<RenderRule>[3],
): ReactNode {
  const body = StyleSheet.flatten(styleMap.body) as TextStyle | undefined;
  const marker: TextStyle = {
    color: body?.color,
    fontSize: body?.fontSize,
    lineHeight: body?.lineHeight,
  };
  // `parent` lists ancestors nearest first; the nearest list decides the marker, so an ordered
  // list nested in a bulleted one is numbered.
  const list = parent.find(
    (ancestor) => ancestor.type === "bullet_list" || ancestor.type === "ordered_list",
  );
  if (list?.type === "bullet_list") {
    return (
      <View key={node.key} style={styleMap._VIEW_SAFE_list_item}>
        <Text style={[marker, styleMap.bullet_list_icon]} accessible={false}>
          {Platform.select({ android: "\u2022", ios: "\u00B7", default: "\u2022" })}
        </Text>
        <View style={layout.listContent}>{children}</View>
      </View>
    );
  }
  if (list?.type === "ordered_list") {
    const start = Number(list.attributes?.start);
    const number = Number.isFinite(start) ? start + node.index : node.index + 1;
    return (
      <View key={node.key} style={styleMap._VIEW_SAFE_list_item}>
        <Text style={[marker, styleMap.ordered_list_icon]}>
          {number}
          {node.markup}
        </Text>
        <View style={layout.listContent}>{children}</View>
      </View>
    );
  }
  return (
    <View key={node.key} style={styleMap._VIEW_SAFE_list_item}>
      {children}
    </View>
  );
}

// Keep links as Text so they stay inside textgroup; Pressable (a View) is laid out
// outside the text flow and collapses the bubble height, overlapping later messages.
const renderRules: RenderRules = {
  list_item: listItemRule,
  text: (node, _children, parents, styleMap, inherited) => (
    <Text key={node.key} style={textStyleForParents(inherited, parents, styleMap)}>
      {node.content}
    </Text>
  ),
  table: (node, children, _parent, styleMap) => (
    <TableScrollView key={node.key} style={styleMap._VIEW_SAFE_table}>
      {children}
    </TableScrollView>
  ),
  tr: (node, children, _parent, styleMap) => (
    <View
      key={node.key}
      style={[styleMap._VIEW_SAFE_tr, { minWidth: node.children.length * TABLE_MIN_COLUMN_WIDTH }]}
    >
      {children}
    </View>
  ),
  link: (node, children, _parent, styleMap) => {
    const href = sanitizeMarkdownUrl(node.attributes.href ?? "");
    if (!href) return <Text key={node.key}>{children}</Text>;
    return (
      <Text
        accessibilityRole="link"
        key={node.key}
        style={styleMap.link}
        onPress={() => {
          void openSafeLink(href);
        }}
      >
        {children}
      </Text>
    );
  },
  blocklink: (node, children, _parent, styleMap) => {
    const href = sanitizeMarkdownUrl(node.attributes.href ?? "");
    if (!href) return <Text key={node.key}>{children}</Text>;
    return (
      <Pressable
        accessibilityRole="link"
        key={node.key}
        onPress={() => {
          void openSafeLink(href);
        }}
        style={styleMap.blocklink}
      >
        <View style={styleMap.image}>{children}</View>
      </Pressable>
    );
  },
  // Replaces the library rule, which loads any http(s) image and prefixes https:// to the rest.
  image: (node, _children, parents, styleMap) => {
    const src = node.attributes.src ?? "";
    const alt = node.attributes.alt;
    if (inlineMarkdownImageSrc(src)) {
      return (
        <FitImage
          key={node.key}
          // Embedded data has nothing to load; the spinner would stay over the image.
          indicator={false}
          style={styleMap._VIEW_SAFE_image}
          source={{ uri: src }}
          accessible={Boolean(alt)}
          accessibilityLabel={alt}
        />
      );
    }
    const linkParent = enclosingLink(parents);
    // Inside a link the label joins the link text, so a badge still opens its link target.
    // A blocklink wraps a view, so the label carries the link style itself when it opens.
    const linkOpens = Boolean(linkParent && sanitizeMarkdownUrl(linkParent.attributes.href ?? ""));
    const labelStyle = linkOpens ? styleMap.link : styleMap.plain_text;
    const remote = remoteMarkdownImage(src);
    if (remote) {
      return (
        <RemoteMarkdownImage
          key={node.key}
          image={remote}
          alt={alt}
          title={node.attributes.title}
          insideLink={Boolean(linkParent)}
          rejectedLink={Boolean(linkParent) && !linkOpens}
          labelStyle={labelStyle}
          styleMap={styleMap}
        />
      );
    }
    return (
      <Text key={node.key} style={labelStyle}>
        {alt || src}
      </Text>
    );
  },
};

export function RemoteMarkdownImage({
  image,
  alt,
  title,
  insideLink,
  rejectedLink,
  labelStyle,
  styleMap,
}: {
  image: { href: string; host: string };
  alt?: string;
  title?: string;
  insideLink: boolean;
  rejectedLink: boolean;
  labelStyle: MarkdownStyleMap[string] | undefined;
  styleMap: MarkdownStyleMap;
}) {
  const loadRemote = useContext(RemoteImagesContext);
  // Bumping this redraws after a tap. Whether the image shows is read from the current URL.
  const [, setRevision] = useState(0);
  if (remoteImageRenders(image.href, loadRemote, rejectedLink)) {
    return (
      <FitImage
        indicator
        style={styleMap._VIEW_SAFE_image}
        source={{ uri: image.href }}
        accessible={Boolean(alt)}
        accessibilityLabel={alt}
      />
    );
  }
  if (insideLink) return <Text style={labelStyle}>{alt || image.host}</Text>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={alt ? `${alt}, ${image.host}` : image.host}
      accessibilityHint={title}
      // A 32pt chip with 6pt slop on each side keeps the 44pt touch target.
      hitSlop={6}
      onPress={() => {
        markRemoteImageLoaded(image.href);
        setRevision((revision) => revision + 1);
      }}
      style={styleMap.image_placeholder}
    >
      <View style={styleMap.image_placeholder_icon} />
      {alt ? (
        <Text numberOfLines={1} style={styleMap.image_placeholder_alt}>
          {alt}
        </Text>
      ) : null}
      <Text numberOfLines={1} style={styleMap.image_placeholder_host}>
        {image.host}
      </Text>
    </Pressable>
  );
}

type LinkifiedTextProps = {
  children: string;
  color: string;
  linkColor: string;
};

export const LinkifiedText = memo(function LinkifiedText({
  children,
  color,
  linkColor,
}: LinkifiedTextProps) {
  return (
    <Text style={{ color, fontSize: 15.5, lineHeight: 23 }}>
      {plainTextLinkParts(children).map((part, index) =>
        part.type === "text" ? (
          part.value
        ) : (
          <Text
            accessibilityRole="link"
            key={index}
            style={{ color: linkColor, textDecorationLine: "underline" }}
            onPress={() => {
              void openSafeLink(part.href);
            }}
          >
            {part.value}
          </Text>
        ),
      )}
    </Text>
  );
});

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  palette = darkTokens,
  colorScheme = "dark",
}: ChatMarkdownProps & { palette?: ColorTokens; colorScheme?: ResolvedAppearance }) {
  const styles = useMemo(() => markdownStyles(palette), [palette]);
  const sharedProps = {
    colorScheme,
    markdownit: markdownParser,
    style: styles,
    rules: renderRules,
    onLinkPress: (url: string) => {
      void openSafeLink(url);
      return false;
    },
  };

  return (
    <View style={layout.wrap}>
      {streaming ? (
        <MarkdownStream {...sharedProps} cursorColor={palette.mutedForeground} streaming>
          {children}
        </MarkdownStream>
      ) : (
        <Markdown {...sharedProps}>{children}</Markdown>
      )}
    </View>
  );
});

const layout = StyleSheet.create({
  wrap: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
  // Deliberately no `flex: 1`: an automatic basis gives the item its text's natural width.
  listContent: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
  },
});

export type { ChatMarkdownProps } from "./markdown";
export { RemoteImagesContext } from "./markdown";
