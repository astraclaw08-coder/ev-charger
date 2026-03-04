import type { Meta, StoryObj } from '@storybook/react';
import StatusBadge from '../components/StatusBadge';

const meta = {
  title: 'Components/StatusBadge',
  component: StatusBadge,
  tags: ['autodocs'],
  args: {
    status: 'ONLINE',
    type: 'charger',
  },
  argTypes: {
    status: {
      control: 'select',
      options: [
        'ONLINE',
        'OFFLINE',
        'FAULTED',
        'AVAILABLE',
        'PREPARING',
        'CHARGING',
        'SUSPENDED_EVSE',
        'SUSPENDED_EV',
        'FINISHING',
        'RESERVED',
        'UNAVAILABLE',
      ],
    },
    type: {
      control: 'radio',
      options: ['charger', 'connector'],
    },
  },
} satisfies Meta<typeof StatusBadge>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ChargerOnline: Story = {
  args: {
    status: 'ONLINE',
    type: 'charger',
  },
};

export const ChargerFaulted: Story = {
  args: {
    status: 'FAULTED',
    type: 'charger',
  },
};

export const ConnectorCharging: Story = {
  args: {
    status: 'CHARGING',
    type: 'connector',
  },
};
