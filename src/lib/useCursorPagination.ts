"use client";

import { useCallback, useState } from "react";

import {
  firstCursorPosition,
  nextCursorPosition,
  previousCursorPosition,
  type CursorPosition,
} from "./cursorPagination";

type SignedPosition = CursorPosition & { signature: string };

export function useCursorPagination(signature: string) {
  const [stored, setStored] = useState<SignedPosition>(() => ({
    signature,
    ...firstCursorPosition(),
  }));
  const position: SignedPosition = stored.signature === signature
    ? stored
    : { signature, ...firstCursorPosition() };

  const previous = useCallback(() => {
    setStored(current => {
      const active = current.signature === signature
        ? current
        : { signature, ...firstCursorPosition() };
      return { signature, ...previousCursorPosition(active) };
    });
  }, [signature]);

  const next = useCallback((nextCursor: string | null) => {
    setStored(current => {
      const active = current.signature === signature
        ? current
        : { signature, ...firstCursorPosition() };
      return { signature, ...nextCursorPosition(active, nextCursor) };
    });
  }, [signature]);

  return { position, previous, next };
}

const createBucketPositions = <T extends string>(keys: readonly T[]) =>
  Object.fromEntries(keys.map(key => [key, firstCursorPosition()])) as Record<T, CursorPosition>;

export function useCursorBuckets<T extends string>(
  signature: string,
  keys: readonly T[],
) {
  const keySignature = keys.join("\u0000");
  const fullSignature = `${signature}\u0001${keySignature}`;
  const [stored, setStored] = useState<{
    signature: string;
    positions: Record<T, CursorPosition>;
  }>(() => ({
    signature: fullSignature,
    positions: createBucketPositions(keys),
  }));
  const positions = stored.signature === fullSignature
    ? stored.positions
    : createBucketPositions(keys);

  const update = useCallback((
    key: T,
    updater: (position: CursorPosition) => CursorPosition,
  ) => {
    setStored(current => {
      const active = current.signature === fullSignature
        ? current.positions
        : createBucketPositions(keys);
      return {
        signature: fullSignature,
        positions: { ...active, [key]: updater(active[key]) },
      };
    });
  }, [fullSignature, keys]);

  const previous = useCallback((key: T) => {
    update(key, previousCursorPosition);
  }, [update]);

  const next = useCallback((key: T, nextCursor: string | null) => {
    update(key, position => nextCursorPosition(position, nextCursor));
  }, [update]);

  return { positions, previous, next };
}
