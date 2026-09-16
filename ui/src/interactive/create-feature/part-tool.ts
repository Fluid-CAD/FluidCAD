import { createNewPart } from '../../api';
import { Navbar } from '../../ui/navbar';
import { FeatureButton } from './feature-button';

/**
 * The Part tool: a one-shot button that appends an empty
 * `part('Part N', () => {})` statement to the current file. No arming and no
 * panel — the render that follows carries the new part, and the caller
 * activates it so subsequent statements land inside its callback body.
 *
 * It owns a group of its own, registered between the history group and the
 * create group so the bar reads `Undo Redo | Part | Sketch Extrude …`: a part
 * is the container every modelling tool fills, so it comes before them and is
 * fenced off from both neighbours by a divider. The group needs no solid to be
 * useful, so it starts visible — an empty file still offers the Part button.
 */
export class PartToolButton {
  readonly button: FeatureButton;
  private inFlight = false;

  constructor(navbar: Navbar, private handlers: {
    /** The server accepted the statement write (the render follows). */
    onCreated: () => void;
    /** A refusal (assembly file open, no scene) to surface as a toast. */
    onRefused: (reason: string) => void;
  }) {
    const group = navbar.getGroup('part') ?? navbar.addGroup('part', { mode: 'part' });
    this.button = new FeatureButton(group, {
      icon: '/icons/box-blue.png',
      label: 'Part',
      tip: 'Create a new part',
      ariaLabel: 'Create a new part',
      datasetTool: 'part',
    });
    this.button.onClick = () => void this.create();
  }

  private async create(): Promise<void> {
    if (this.inFlight) {
      return;
    }
    this.inFlight = true;
    try {
      const result = await createNewPart();
      if (result.success) {
        this.handlers.onCreated();
      } else {
        this.handlers.onRefused(result.reason ?? 'Could not create the part');
      }
    } finally {
      this.inFlight = false;
    }
  }
}
