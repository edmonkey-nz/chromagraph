future improvements.
1) save project fucntionality
   - DONE (2026-10-09): Save button with a "Saved hh:mm:ss" indicator, Save as…
     (copies the project and its data), and Snapshots (named versions you can restore;
     restoring first keeps a "before restore" snapshot). Autosave still runs.
2) build additonal chart domains - something that replaces last one, so each chart can morph to next one , with a morph/crossfade slider value on speed (0.1-10s)
   - DONE (2026-10-09): Scenes card. Capture a look as a scene, then Go / Previous / Next.
     Matching layers morph and the rest crossfade, over 0.1–10 s with easing (per scene if
     wanted).
   - Not yet: playing scenes in sequence automatically from the timeline, for unattended
     installations.
3) add some glow and trail sort of effectors
   - DONE (2026-10-09): bloom glow and motion trails in the Output & effects card. Both
     can be animated with modulators.
   - Ideas: per-layer glow, colour grading, feedback/kaleidoscope.
4) the main controls need to take up most of the screen the data pane can be a tabbed pane across the top, try and visually differniate the panes in the controls more, they look a bit hard and bad windows-era UI. the visualiser needs to be maybe top left, and then the main area can be the controls. have a good consideraiton about the grouping the control panes are in, and if they should be splt into new columns in the main section, with some (small) padding - 
   - DONE (2026-10-09): the preview is top left, with the data tabs across the top. The
     controls are cards in columns: Show (Scenes, Timeline, Modulation), Look (Output &
     effects, Camera) and Layers (wide, one card per layer).
   - Waiting for your feedback on the look.
6) add a 'custom text' layer, so i can add the words
   - Mostly there already: Add layer → **text**, choose no dataset, and type your words in
     the text box. It supports font size, colour, alignment, wrap width, outline and a
     custom font URL, and it can move, fade and morph like any layer.
   - To do if wanted: a font picker with bundled fonts, and an easier way to add text
     without going through the layer type list.
