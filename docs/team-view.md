# Team View

Team View is the docked replacement for the former Overview pane. The saved
dock id remains `overview`, so an existing layout opens Team View in the same
place; its tab and View-menu name are **Team View**. The Session List is a
separate dockable tool and both surfaces may be visible together.

Each project with open sessions is a department and each session is a desk.
Desk monitors show only a short, passive, clipped tail of that session's real
PTY output. They cannot receive focus or input. Selecting a desk uses the same
normal session-selection path as Session List and `Ctrl+number`; Terminal
remains the only interactive terminal surface.

`Ctrl+1` through `Ctrl+9` and `Ctrl+0` are displayed only on desks assigned by
the shared Session List shortcut map. Department collapse is saved with the
existing session-group preferences. Desk state, waiting cue, lock, visibility,
rename, artifact, and close controls are projections of the existing session
boundaries rather than a second Team View state store.
