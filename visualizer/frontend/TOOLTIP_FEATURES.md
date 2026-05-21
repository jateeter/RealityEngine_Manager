# Event Details Tooltip - Quick Reference

## Overview
Hover over any event node in the D3.js force-directed graph to see comprehensive event details.

## What's Displayed

### 📋 Header Section
- Event name (large, blue, bold)
- State badges (INITIAL/ACTIVE/OUTPUT)
- Event ID (monospace)
- Label (if different from name)
- Sequence name (purple)

### 🔢 Event Vector Section
Shows all vector elements with:
- Element index [0], [1], [2]...
- Element value (3 decimal places)
- Comparator type (EQUALS, GREATER_THAN, etc.)
- Threshold value (when defined)

### 📝 Metadata Section
Displays all metadata key-value pairs:
- Formatted as label: value
- JSON stringified for complex objects
- Excludes redundant fields

### 📤 Output Vectors Section
Lists all outputs with:
- Output ID and index number
- Vector values (2 decimal places)
- Output metadata
- Timestamp (formatted time)

## Visual Features

### Colors
- **Blue**: Event names, headers, borders
- **Green**: Active events, vector values
- **Orange**: Output events, output section
- **Purple**: Sequence names
- **Gray**: Metadata, labels

### Animations
- **Fade In**: 150ms smooth entrance
- **Fade Out**: 100ms smooth exit
- **Node Expansion**: Grows from 15px to 18px on hover
- **Brightness**: Increases 1.5x on hover

### Smart Positioning
- Automatically repositions near screen edges
- Never goes off-screen
- 20px margins from window edges
- Adjusts for tooltip dimensions

### Scrolling
- Custom blue scrollbar (8px width)
- Appears when content exceeds window height
- Maximum height: window height - 40px
- Smooth scrolling

## Interaction

### Mouse Enter
1. Node expands and brightens
2. Tooltip fades in
3. Connected nodes/edges highlighted
4. Other elements dimmed

### Mouse Leave
1. Node returns to normal size
2. Tooltip fades out
3. All highlights removed
4. All elements restore to full opacity

## Example Use Cases

### Debug Event State
Quickly inspect:
- Current vector element values
- Comparator types and thresholds
- Event metadata

### Review Outputs
Check:
- Which outputs were triggered
- Output vector values
- Output timestamps and metadata

### Understand Sequences
See:
- Which sequence an event belongs to
- Event role (initial/active/output)
- Connection to other events

## Keyboard Shortcuts
While tooltip is mouse-only, the graph supports:
- **Scroll**: Zoom in/out
- **Drag background**: Pan
- **Drag nodes**: Reposition

## Tips

### Long Content
- Tooltip becomes scrollable automatically
- Scroll within tooltip to see all data
- Maximum height adapts to window size

### Multiple Outputs
- All outputs listed in chronological order
- Each output shows full details
- Scrollable if many outputs

### Complex Metadata
- Objects shown as JSON
- Long values word-wrapped
- All fields displayed

## File Location
`/visualizer/frontend/src/components/CriticalEventGraphView.tsx`

## Documentation
- `ENHANCED_TOOLTIP_SUMMARY.md` - Complete technical details
- `TOOLTIP_EXAMPLE.md` - Visual examples and diagrams
