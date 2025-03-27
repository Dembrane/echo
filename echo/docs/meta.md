# Doc about the docs (design decisions and more)

## Why is a lot of code in this project redundant?

The idea here is: prefer duplication over the wrong abstraction.

You might have noticed that a lot of code is redundant and repetitive.

It is an artifact of using the style guides with Cursor chat. It helps write code faster.
This is a "tailwind-y" way of writing code.

## So, how do I use the docs to write code with Cursor chat?

- Add the `@docs` folder to your cursor context to ask questions
- When doing something specific like adding spacing, find and then use the doc related to it (`@frontend_spacing.md`)
- If you want to refactor, update the style guide doc and then ask Cursor to do a codebase wide refactor.

- Opinion alert: Why this and not `.cursor/rules` you ask? This way more explicit and you can be intentional and sure that the rules are applied.

## When should I add something?

You must add a doc to this folder if you believe

- you are doing something that is not obvious
- tedious patterns that reoccur
- troubleshooting some specific issue

## A recipe that I use to write style guides

- I solve a problem in code in a specific way by doing it by hand or through cursor chat
- I ask cursor to look at the diff and write a style guide doc about it using the following prompt:


```
# Style Guide: [Pattern Name]

## Context

- Brief description of the pattern/issue that was fixed
- Why it matters (performance, maintainability, readability, etc.)

## Before & After Examples

### ❌ Don't

// Example of the problematic pattern


### ✅ Do

// Example of the correct implementation

## Guidelines

1. **Core Rule**

   - Main principle to follow
   - Key considerations

2. **Implementation Details**

   - Specific steps or patterns to follow
   - Edge cases to consider

3. **Common Pitfalls**
   - List of related issues to watch out for
   - Common misconceptions

## How to Find Similar Patterns

### Git Grep Commands

# Example search patterns to find similar issues
git grep -n "pattern"

### Automated Detection

- Linting rules that can help (if applicable)
- CI checks to implement

## Migration Strategy

1. How to identify affected code
2. Steps for systematic updates
3. Testing considerations

## References

- Related documentation
- Relevant team discussions
- Performance metrics (if applicable)
```

