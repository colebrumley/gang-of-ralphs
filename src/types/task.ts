export interface Task {
  id: string;
  title: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  dependencies: string[]; // Task IDs this depends on
  estimatedIterations: number;
  assignedLoopId: string | null;
}

export interface TaskGraph {
  tasks: Task[];
  parallelGroups: string[][]; // Groups of task IDs that can run in parallel
}
