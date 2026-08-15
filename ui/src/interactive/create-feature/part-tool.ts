import { createNewPart } from '../../api';
import { Navbar } from '../../ui/navbar';
import { FeatureButton } from './feature-button';

/**
 * The Part tool: a one-shot create-group button that appends an empty
 * `part('Part N', () => {})` statement to the current file. No arming and no
 * panel — the render that follows carries the new part, and the caller
 * activates it so subsequent statements land inside its callback body.
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
    const group = navbar.getGroup('create') ?? navbar.addGroup('create', { visible: false, immune: true });
    this.button = new FeatureButton(group, {
      icon: '/icons/box.png',
      label: 'Part',
      tip: 'Create a new part',
      ariaLabel: 'Create a new part',
      datasetTool: 'part',
      prepend: true,
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
