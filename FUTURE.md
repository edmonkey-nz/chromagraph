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
   - DONE (2026-10-09): glow and trails are now per layer, in each layer's Glow and Trails
     folders.
4) the main controls need to take up most of the screen the data pane can be a tabbed pane across the top, try and visually differniate the panes in the controls more, they look a bit hard and bad windows-era UI. the visualiser needs to be maybe top left, and then the main area can be the controls. have a good consideraiton about the grouping the control panes are in, and if they should be splt into new columns in the main section, with some (small) padding - 
   - DONE (2026-10-09): the preview is top left, with the data tabs across the top. The
     controls are cards in columns: Show (Scenes, Timeline, Modulation), Look (Output &
     effects, Camera) and Layers (wide, one card per layer).
   - Waiting for your feedback on the look.
   - Since reworked (2026-10-09): preview, timeline strip and Camera on the left; tabs on the
     right for Scene, Datasets, Layers and Timeline; Output windows, Diagnostics, Problems
     and Log in a drawer along the bottom.
6) DONE - add a 'custom text' layer, so i can add the words
   - Mostly there already: Add layer → **text**, choose no dataset, and type your words in
     the text box. It supports font size, colour, alignment, wrap width, outline and a
     custom font URL, and it can move, fade and morph like any layer.
   - To do if wanted: a font picker with bundled fonts, and an easier way to add text
     without going through the layer type list.
7) the labels need an option as to placement on the 'small mulptiles' as currently they sit outside the graph, and maybe options: top, baseline, outside frame (as it is currently)
   - DONE (2026-10-09): small multiples → title placement: outside (as before), top (inside
     along the top) or baseline (inside along the bottom).
8) any text that is displayed must not have its leading 0 stripped, as it make the text jump. 
   - DONE (2026-10-09): numbers show the decimals the CSV writes ("12.30" stays "12.30",
     "0.0" stays "0.0"), and dates pad the day ("02 Jan 1879"), so text keeps its width.
9) add a drop shadow option in the 'look' section, colour, spread, opcacity.
   - DONE (2026-10-10): each layer has a Shadow folder: colour, opacity, spread (softness)
     and x/y offset.
10) layers pane - make the first column narrower and only have the dispaly of each they look collaspeed, but this is actually a button to open the settings for that layer in the 2nd column. remove the 'collaspse all' button. move the 'add layer section' beofre the layer list in the first column.  
   - DONE (2026-10-09): Layers tab is a narrow list (Add layer on top, then one row per
     layer: move, duplicate, delete). Click a row to open its settings on the right.
     Collapse all is gone.
11) duplicate the 'project timeline' ( from the timeline pane ) to appear under the main preview visualiser, so i can easily see where the playback is, and drag the playback head if i need to.
   - DONE (2026-10-09): the timeline strip under the preview: play/pause, restart,
     position, playback mode, and a ruler you can click or drag to scrub.
12) add a layer option (maybe in the 'transform' pane) with a checkbox "always facing camera" , so the layer ignores the camera movement. will need to see how this working in terms of scale etc. 
   - DONE (2026-10-10) as "fixed to screen" in the Transform folder: the layer is drawn
     flat on screen at its 2D size, so 3D camera moves don't affect it (good for titles).
13) ON HOLD, POSTPONE - look into 'laser arcade' sibling project, and get the bluetooth conotrller code and implement an 'override camera with conroller' mode, so i can use the joysticks to control the camera in realtime.
14) swap the order of the output    buttons, and replace with icons
   - DONE (2026-10-09): icon buttons in the order window, projector, close.
15) add a 'about' button (? icon) after the title in the top header bar, and make this open in a modal the 'ABOUT.md' file, with a close button /escape key.
   - DONE (2026-10-09): the ? after the title opens ABOUT.md; close with the button or Esc.
     (ABOUT.md is empty at the moment, so the box is blank.)
16)rename the 'timeline' pane inside the 'scene' tab to 'scene timeline' 
   - DONE (2026-10-09).
17) add an option on the 'scene' pane under the 'playback' for 3 settings - 'fade in' checbox, 'fade out' checkbox, and 'gap before restart' (0-5 secs) - this is for when settigns forwar or reverse are used and theres a fade out of all layers on scene so its not a harsh visual jump.
   - DONE (2026-10-09): Scene timeline → fade in, fade out, fade length (0.1–10 s) and gap
     before restart (0–5 s). The whole output fades to the background colour.
18a) camera depth of field,  is this something that can be added to the cameras output as a slider?
   - DONE (2026-10-10): Camera card → Depth of field (3D only): focus, sharp depth and
     blur, plus Focus on target. Can be animated for a rack focus; titles fixed to the
     screen stay sharp. Costs about 1.5 ms a frame.
18b) add a 'blur' option with slider value on the 'look' pane for each layer - is this possible ?
   - DONE (2026-10-10): each layer has a Blur folder with an amount in px.
19) look at the images in the /.temp/ folder - are there ways to build outputs a bit like these - isometric look, 3d glowing edge loook, 3d coloured edge.  ask questions and validate effort and performance before building.
   - DONE (2026-10-10): Camera → Isometric view; box layers have an Edges folder (colour,
     width, face opacity, edge glow) with Red outline and Neon presets; and a new
     "reflection plane" layer for mirror floors (place it with the gizmo or Lay flat as
     floor). All three looks ran at 60 fps on the GTX 1650.
20) add a 'source' and 'attrubution' field per dataset. and make this an option from a text layer to show
   - DONE (2026-10-10): Datasets tab → source, link and attribution per dataset. Text
     layers show them with {@credit} ("Source: … · …"), {@source}, {@url} and
     {@attribution}; Insert credit adds {@credit}. Edits update the output live.
21) add a QR generator as a layer with options for URL etc, so i can display for 'more info/source ' etc
   - DONE (2026-10-10): Add layer → QR code. Encodes typed text or the dataset's link;
     error correction, margin, colours, size and centre; works fixed to screen and in 3D.
     Checked by decoding screenshots of the output.
23) update the readme, to make more generic for any users hardware setup, mention GPU requiremnts etc, but dont tie to my laptop. metionk chrome requirements, make simpler 
   - DONE (2026-10-10): README rewritten for any machine: requirements (Node, Chrome,
     GPU), install and start, a GPU check for Windows, macOS and Linux, installations, and
     a shorter feature list. Laptop-specific notes moved out.
24) review if this can be make an execuatable across windows/ubuntu/macos - explain first
   - Options written up in docs/packaging-options.md (portable folder, single executable,
     Electron, Tauri), with effort, signing costs and a suggested path. Nothing built.

25) in the 'add instance' dropdown, under each option, add a simple 1 sentence max description in a slighty visual difference from the option name

26) in the camera > motion pane, i need a timeline slider with current positon for the camera, so i can jog or reset its camera timeline

27) add a basic CSV explorer/viewer in the 'dataset' pane

28) add a 'random layer settings' button in the 'general' pane. make them sensible, and often will need to be 'fit to output' as a starting point. open to thoughts on this.
29) 