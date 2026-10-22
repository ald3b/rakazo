import type { ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CellRendererProps,
  FlatList,
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";
import { StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import type {
  InboxSignal,
  JumpDirection,
  JumpPill,
  RowLayout,
  VisibleRange,
} from "../lib/offscreen-unreads";
import {
  estimateRowLayout,
  jumpOffset,
  offscreenUnreads,
  PILL_GAP,
  visibleRange,
} from "../lib/offscreen-unreads";
import { UNREAD_JUMP_PILL_HEIGHT, UnreadJumpPill } from "./unread-jump-pill";

const entering = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const exiting = FadeOut.duration(160).reduceMotion(ReduceMotion.System);

/**
 * Pills over the inbox that count unread chats scrolled out of view above and below, and
 * scroll to the nearest one. `signals` and `keys` follow the list's rows, keys as the list's
 * `keyExtractor` gives them. `topInset` and `bottomInset` are the parts of the list hidden
 * under the floating header and the home indicator.
 */
export function useUnreadJumpPills<Item>({
  signals,
  keys,
  listRef,
  topInset,
  bottomInset,
}: {
  signals: readonly InboxSignal[];
  keys: readonly string[];
  listRef: RefObject<FlatList<Item> | null>;
  topInset: number;
  bottomInset: number;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  // Measured rows by key, so a row keeps its layout when rows above it come or go.
  const layouts = useRef(new Map<string, RowLayout>());
  // A jump to a row not measured yet: it scrolls to an estimate, then here once the row lays out.
  const pendingJump = useRef<{ key: string; direction: JumpDirection } | null>(null);
  // At rest the list sits at its top inset: content y 0 shows just under the header.
  const scroll = useRef({ offset: -topInset, viewportHeight: 0, contentHeight: 0 });
  const [range, setRange] = useState<VisibleRange>();
  const count = signals.length;
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const refresh = useCallback(() => {
    const { offset, viewportHeight } = scroll.current;
    if (viewportHeight === 0) return;
    const rows = keysRef.current.slice(0, count).map((key) => layouts.current.get(key));
    const next =
      offset < -topInset - 1
        ? undefined
        : visibleRange(rows, {
            top: offset + topInset,
            bottom: offset + viewportHeight - bottomInset,
          });
    setRange((current) =>
      current?.first === next?.first && current?.last === next?.last ? current : next,
    );
  }, [count, topInset, bottomInset]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  // New rows or a new order need a recount before any row lays out again.
  useEffect(() => {
    if (pendingJump.current && !keys.includes(pendingJump.current.key)) pendingJump.current = null;
    refresh();
  }, [refresh, keys]);

  const scrollTo = (direction: JumpDirection, key: string, layout: RowLayout) => {
    const { viewportHeight, contentHeight } = scroll.current;
    listRef.current?.scrollToOffset({
      offset: jumpOffset(direction, layout, {
        viewportHeight,
        contentHeight,
        topInset,
        bottomInset,
        pillSpace: PILL_GAP + UNREAD_JUMP_PILL_HEIGHT + PILL_GAP,
        isLast: key === keysRef.current[keysRef.current.length - 1],
      }),
    });
  };
  const scrollToRef = useRef(scrollTo);
  scrollToRef.current = scrollTo;

  // Viewability does not subtract the floating header, safe area or landing pill space.
  // Replace FlatList's cell container to measure variable-height rows without extra wrappers.
  const CellRendererComponent = useMemo(
    () =>
      function InboxCell({ cellKey, onLayout, style, children }: CellRendererProps<Item>) {
        return (
          <View
            style={style}
            onLayout={(event) => {
              onLayout?.(event);
              const { y, height } = event.nativeEvent.layout;
              layouts.current.set(cellKey, { y, height });
              const pending = pendingJump.current;
              if (pending?.key === cellKey) {
                pendingJump.current = null;
                scrollToRef.current(pending.direction, cellKey, { y, height });
              }
              refreshRef.current();
            }}
          >
            {children}
          </View>
        );
      },
    [],
  );

  const listProps = useMemo(
    () => ({
      CellRendererComponent,
      scrollEventThrottle: 16,
      // The top of the list sits at a negative offset under the floating header; without this
      // a jump to the first rows stops at 0, behind the header.
      scrollToOverflowEnabled: true,
      // Scrolling by hand cancels a jump still waiting for its row.
      onScrollBeginDrag: () => {
        pendingJump.current = null;
      },
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
        scroll.current = {
          offset: contentOffset.y,
          viewportHeight: layoutMeasurement.height,
          contentHeight: contentSize.height,
        };
        refreshRef.current();
      },
      onLayout: (event: LayoutChangeEvent) => {
        scroll.current.viewportHeight = event.nativeEvent.layout.height;
        refreshRef.current();
      },
      onContentSizeChange: (_width: number, height: number) => {
        scroll.current.contentHeight = height;
        refreshRef.current();
      },
    }),
    [CellRendererComponent],
  );

  const pills = useMemo(() => (range ? offscreenUnreads(signals, range) : {}), [signals, range]);

  const jump = (direction: JumpDirection, pill: JumpPill) => {
    const key = keys[pill.index];
    if (key === undefined) return;
    const layout = layouts.current.get(key);
    if (layout) {
      pendingJump.current = null;
      scrollTo(direction, key, layout);
      return;
    }
    // Far rows aren't rendered yet: scroll to where the row should be so it renders, then
    // land on it exactly once it has laid out.
    pendingJump.current = { key, direction };
    scrollTo(
      direction,
      key,
      estimateRowLayout(
        keys.flatMap((rowKey) => {
          const row = layouts.current.get(rowKey);
          return row ? [row] : [];
        }),
        pill.index,
      ),
    );
  };

  const edge = (direction: JumpDirection, pill: JumpPill | undefined): ReactNode => {
    if (!pill) return null;
    const one = pill.count === 1;
    const label =
      pill.kind === "unread"
        ? one
          ? t("1 unread")
          : t("{count} unread", { count: pill.count })
        : one
          ? t("Needs attention")
          : t("{count} need attention", { count: pill.count });
    return (
      <Animated.View
        key={direction}
        testID={`home-unread-pill-${direction}`}
        pointerEvents="box-none"
        entering={entering}
        exiting={exiting}
        style={[
          styles.edge,
          direction === "above" ? { top: topInset + PILL_GAP } : { bottom: bottomInset + PILL_GAP },
        ]}
      >
        <UnreadJumpPill
          direction={direction}
          label={label}
          accessibilityHint={direction === "above" ? t("Scrolls up") : t("Scrolls down")}
          color={pill.kind === "unread" ? tokens.unread : tokens.attention}
          onPress={() => jump(direction, pill)}
        />
      </Animated.View>
    );
  };

  return {
    listProps,
    overlay: (
      <>
        {edge("above", pills.above)}
        {edge("below", pills.below)}
      </>
    ),
  };
}

const styles = StyleSheet.create({
  edge: {
    position: "absolute",
    start: 0,
    end: 0,
    alignItems: "center",
  },
});
