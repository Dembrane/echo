# Guide: Creating Resizable Elements with `re-resizable`

## 1. Basic Resizable Panel

```tsx
function BasicResizable() {
  const [width, setWidth] = useState(400);
  const [height, setHeight] = useState(300);

  return (
    <Resizable
      size={{ width, height }}
      minWidth={300}
      maxWidth={500}
      minHeight={300}
      maxHeight={800}
      onResizeStop={(_e, _direction, _ref, d) => {
        setWidth(width + d.width);
        setHeight(height + d.height);
      }}
    >
      <div className="h-full w-full border">
        Content here
      </div>
    </Resizable>
  );
}
```

## 2. Common Use Cases

### Resizable Sidebar
```tsx
function ResizableSidebar() {
  const [width, setWidth] = useState(300);
  
  return (
    <Resizable
      size={{ width, height: "100%" }}
      minWidth={200}
      maxWidth={500}
      enable={{
        right: true,    // Only allow right-side resizing
        left: false,
        top: false,
        bottom: false,
      }}
      onResizeStop={(_e, _direction, _ref, d) => {
        setWidth(width + d.width);
      }}
    >
      <div className="h-full border-r">
        Sidebar content
      </div>
    </Resizable>
  );
}
```

### Resizable Panel with Sticky Preview (like in your example)
```tsx
function StickyPreviewPanel() {
  const [width, setWidth] = useState(400);
  const [height, setHeight] = useState(300);

  return (
    <div className="relative">
      <div className="sticky top-4">
        <Resizable
          size={{ width, height }}
          // ... other props
        >
          <div className="h-full w-full border">
            Preview content
          </div>
        </Resizable>
      </div>
    </div>
  );
}
```

### Resizable Split View
```tsx
function ResizableSplitView() {
  const [width, setWidth] = useState(400);

  return (
    <div className="flex">
      <div className="flex-1">Left content</div>
      <Resizable
        size={{ width, height: "100%" }}
        minWidth={300}
        maxWidth={800}
        enable={{
          left: true,     // Only allow left-side resizing
          right: false,
          top: false,
          bottom: false,
        }}
        onResizeStop={(_e, _direction, _ref, d) => {
          setWidth(width + d.width);
        }}
      >
        <div className="h-full border-l">
          Right panel content
        </div>
      </Resizable>
    </div>
  );
}
```

## 3. Handle Styling Tips

```tsx
// Minimal handle styles
handleStyles={{
  left: {
    width: "4px",
    left: "-2px",
    cursor: "col-resize",
  }
}}

// More visible handles
handleStyles={{
  left: {
    width: "8px",
    left: "-4px",
    cursor: "col-resize",
    backgroundColor: "#f0f0f0",
  }
}}

// With hover effects (Tailwind)
handleClasses={{
  left: "hover:bg-blue-500/20 transition-colors",
}}
```

## Key Considerations:

1. **Choose Resize Directions Wisely**
   - Enable only the handles that make sense for your use case
   - Most panels only need one or two resize directions

2. **Handle Sizing**
   - Wider handles (6-8px) are easier to grab
   - Negative margins help create a better grab area
   - Consider adding visual feedback on hover

3. **Constraints**
   - Always set reasonable min/max dimensions
   - Consider the container's size when setting maxWidth/maxHeight

4. **Performance**
   - Use `onResizeStop` for state updates instead of `onResize` for better performance
   - Consider debouncing updates if needed

5. **Accessibility**
   - Add appropriate ARIA labels if needed
   - Ensure sufficient color contrast for handle hover states

The sticky behavior should only be added when you need the panel to stay in view during scroll, such as in preview panels or persistent toolbars.