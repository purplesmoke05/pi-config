export interface ResponsiveSegment {
  content: string;
  width: number;
  secondary: boolean;
}

export interface ResponsivePartition {
  top: string[];
  secondary: string[];
}

/**
 * Partition rendered segments across the footer's top and secondary rows.
 *
 * Declared secondary segments are allowed to move onto the top row when every
 * earlier segment fits. Once the top row overflows, declared secondary content
 * is prioritized on row two ahead of optional primary overflow. This prevents
 * quota/status indicators from disappearing behind path/git/token segments on
 * narrow terminals.
 */
export function partitionResponsiveSegments(
  segments: readonly ResponsiveSegment[],
  availableWidth: number,
  separatorWidth: number,
  baseOverhead = 2,
): ResponsivePartition {
  let topWidth = baseOverhead;
  const top: string[] = [];
  const overflow: ResponsiveSegment[] = [];
  let hasOverflow = false;

  for (const segment of segments) {
    const neededWidth = segment.width + (top.length > 0 ? separatorWidth : 0);
    if (!hasOverflow && topWidth + neededWidth <= availableWidth) {
      top.push(segment.content);
      topWidth += neededWidth;
    } else {
      hasOverflow = true;
      overflow.push(segment);
    }
  }

  const prioritizedOverflow = [
    ...overflow.filter((segment) => segment.secondary),
    ...overflow.filter((segment) => !segment.secondary),
  ];
  let secondaryWidth = baseOverhead;
  const secondary: string[] = [];

  for (const segment of prioritizedOverflow) {
    const neededWidth = segment.width + (secondary.length > 0 ? separatorWidth : 0);
    if (secondaryWidth + neededWidth > availableWidth) break;
    secondary.push(segment.content);
    secondaryWidth += neededWidth;
  }

  return { top, secondary };
}
