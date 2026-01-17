import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { GradeConfig, TestCase, TestCaseInput, TestSuite } from './types.js';

const CASES_DIR = 'evals/cases';

interface RawTestCase {
  id: string;
  description: string;
  input: Record<string, unknown>;
  grade: {
    criteria: string[];
    rubric: string;
  };
}

interface RawTestSuite {
  name: string;
  prompt: string;
  cases: RawTestCase[];
}

function validateTestCase(raw: RawTestCase, suiteName: string): TestCase {
  if (!raw.id || typeof raw.id !== 'string') {
    throw new Error(`Invalid test case in ${suiteName}: missing or invalid 'id'`);
  }
  if (!raw.description || typeof raw.description !== 'string') {
    throw new Error(
      `Invalid test case ${raw.id} in ${suiteName}: missing or invalid 'description'`
    );
  }
  if (!raw.input || typeof raw.input !== 'object') {
    throw new Error(`Invalid test case ${raw.id} in ${suiteName}: missing or invalid 'input'`);
  }
  if (!raw.grade || typeof raw.grade !== 'object') {
    throw new Error(`Invalid test case ${raw.id} in ${suiteName}: missing or invalid 'grade'`);
  }
  if (!Array.isArray(raw.grade.criteria) || raw.grade.criteria.length === 0) {
    throw new Error(
      `Invalid test case ${raw.id} in ${suiteName}: 'grade.criteria' must be a non-empty array`
    );
  }
  if (!raw.grade.rubric || typeof raw.grade.rubric !== 'string') {
    throw new Error(
      `Invalid test case ${raw.id} in ${suiteName}: missing or invalid 'grade.rubric'`
    );
  }

  return {
    id: raw.id,
    description: raw.description,
    input: raw.input as TestCaseInput,
    grade: raw.grade as GradeConfig,
  };
}

function validateTestSuite(raw: RawTestSuite, filename: string): TestSuite {
  if (!raw.name || typeof raw.name !== 'string') {
    throw new Error(`Invalid test suite in ${filename}: missing or invalid 'name'`);
  }
  if (!raw.prompt || typeof raw.prompt !== 'string') {
    throw new Error(`Invalid test suite ${raw.name}: missing or invalid 'prompt'`);
  }
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error(`Invalid test suite ${raw.name}: 'cases' must be a non-empty array`);
  }

  return {
    name: raw.name,
    prompt: raw.prompt,
    cases: raw.cases.map((c) => validateTestCase(c, raw.name)),
  };
}

/**
 * Load a single test suite from a YAML file
 */
export async function loadTestSuite(filePath: string): Promise<TestSuite> {
  const content = await readFile(filePath, 'utf-8');
  const raw = parse(content) as RawTestSuite;
  return validateTestSuite(raw, filePath);
}

/**
 * Load all test suites from the evals/cases directory
 */
export async function loadAllTestSuites(baseDir: string = process.cwd()): Promise<TestSuite[]> {
  const casesDir = join(baseDir, CASES_DIR);
  const files = await readdir(casesDir);
  const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));

  const suites: TestSuite[] = [];
  for (const file of yamlFiles) {
    const suite = await loadTestSuite(join(casesDir, file));
    suites.push(suite);
  }

  return suites;
}

/**
 * Load a specific test suite by name
 */
export async function loadTestSuiteByName(
  name: string,
  baseDir: string = process.cwd()
): Promise<TestSuite> {
  const casesDir = join(baseDir, CASES_DIR);
  const possiblePaths = [join(casesDir, `${name}.yaml`), join(casesDir, `${name}.yml`)];

  for (const path of possiblePaths) {
    try {
      return await loadTestSuite(path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw e;
      }
    }
  }

  throw new Error(`Test suite not found: ${name}`);
}
