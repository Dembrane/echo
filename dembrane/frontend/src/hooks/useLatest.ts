import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * A ref that always holds the latest `value`, for code that runs outside
 * render and must not re-subscribe when the value changes: an effect's
 * listener, a timer, a d3 callback.
 *
 *     const onLimitRef = useLatest(onLimit);
 *     useEffect(() => {
 *       const id = setInterval(() => onLimitRef.current(), 1000);
 *       return () => clearInterval(id);
 *     }, [onLimitRef]);
 *
 * Use it instead of `ref.current = value` in the component body: writing a
 * ref during render is something React Compiler can't compile. The ref is
 * written in a layout effect, after the render commits and before any
 * effect declared after this call runs, so effects and handlers see the
 * value from the render they belong to.
 *
 * Read `.current` only in effects, handlers and callbacks, never during
 * render: during render, use `value` itself.
 */
export function useLatest<T>(value: T): RefObject<T> {
	const ref = useRef(value);
	useLayoutEffect(() => {
		ref.current = value;
	});
	return ref;
}
