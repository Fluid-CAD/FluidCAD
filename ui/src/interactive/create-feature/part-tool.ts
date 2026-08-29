import { createNewPart } from '../../api';
import { Navbar } from '../../ui/navbar';
import { FeatureButton } from './feature-button';

/**
 * The Part tool: a one-shot button that appends an empty
 * `part('Part N', () => {})` statement to the current file. No arming and no
 * panel — the render that follows carries the new part, and the caller
 * activates it so subsequent statements land inside its callback body.
 *
 * It shares the trailing connector group and prepends ahead of the Connector
 * button (…, | Boolean, | Offset, | Part, Connector): both are structure tools
 * rather than modelling ones. Unlike the Connector button it needs no solid to
 * work on, so it votes the group visible under its own slot — an empty file
 * still shows the group, with only the Part button inside it.
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
    const group = navbar.getGroup('connector')
      ?? navbar.addGroup('connector', { visible: false, mode: 'part' });
    navbar.setGroupVisible('connector', true, 'part');
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
