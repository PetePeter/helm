/**
 * A layout with every pane open and Artifacts + Draft in a right-edge
 * autohide dock, so dock behaviour (reveal, hide, collapse, legacy width
 * migration) can be tested independently of whatever the shipped default is.
 */
import {
  DOCK_LAYOUT_VERSION,
  PANE_ARTIFACTS,
  PANE_CHAT,
  PANE_DRAFT,
  PANE_MEMORIES,
  PANE_MESS,
  PANE_PLAN_DIRECTORIES,
  PANE_PLAN_SCREEN,
  PANE_QUICK_SPAWN,
  PANE_SCHEDULER,
  PANE_SESSIONS,
  PANE_TERMINAL,
  PANE_TIMESHEET,
  PANE_TODOS,
  type DockWorkspaceLayout,
} from '../../renderer/dock-types';

export function edgeDockLayout(): DockWorkspaceLayout {
  return {
    version: DOCK_LAYOUT_VERSION,
    root: {
      type: 'split',
      direction: 'horizontal',
      sizes: [0.22, 0.56, 0.22],
      children: [
        {
          type: 'dock', side: 'left', mode: 'pinned',
          child: {
            type: 'split',
            direction: 'vertical',
            sizes: [0.6, 0.4],
            children: [
              { type: 'group', tabs: [PANE_SESSIONS], activeTab: PANE_SESSIONS },
              { type: 'group', tabs: [PANE_SCHEDULER, PANE_QUICK_SPAWN, PANE_PLAN_DIRECTORIES], activeTab: PANE_SCHEDULER },
            ],
          },
        },
        { type: 'group', tabs: [PANE_TERMINAL, PANE_CHAT, PANE_PLAN_SCREEN, PANE_MEMORIES, PANE_MESS, PANE_TIMESHEET], activeTab: PANE_TERMINAL },
        {
          type: 'dock', side: 'right', mode: 'autohide',
          child: { type: 'group', tabs: [PANE_ARTIFACTS, PANE_DRAFT, PANE_TODOS], activeTab: PANE_ARTIFACTS },
        },
      ],
    },
    closed: [],
  };
}
