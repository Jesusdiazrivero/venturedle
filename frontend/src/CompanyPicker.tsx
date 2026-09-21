/**
 * The typeahead. Matching is a case-insensitive `includes` on the name and on the id, so both
 * "klar" and "klarna.com" find Klarna; already-guessed companies are gone from the list rather than
 * rejected after the fact (the server would answer `already_guessed`).
 */
import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { CompanyLite } from "@venturedle/shared";

const MAX_SUGGESTIONS = 8;

export function CompanyPicker({
  companies,
  guessedIds,
  disabled,
  onPick,
}: {
  companies: readonly CompanyLite[];
  guessedIds: readonly string[];
  disabled: boolean;
  onPick: (company: CompanyLite) => void;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const guessed = new Set(guessedIds);
    return companies
      .filter(
        (company) =>
          !guessed.has(company.id) &&
          (company.name.toLowerCase().includes(needle) ||
            company.id.toLowerCase().includes(needle)),
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [companies, guessedIds, query]);

  function pick(company: CompanyLite | undefined) {
    if (!company) return;
    setQuery("");
    setHighlight(0);
    onPick(company);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((i) => Math.min(i + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(matches[highlight] ?? matches[0]);
    } else if (event.key === "Escape") {
      setQuery("");
      setHighlight(0);
    }
  }

  return (
    <div className="picker">
      <input
        className="picker-input"
        type="text"
        role="combobox"
        aria-label="Guess a company"
        aria-expanded={matches.length > 0}
        aria-controls="picker-listbox"
        aria-autocomplete="list"
        {...(matches[highlight]
          ? { "aria-activedescendant": `picker-option-${highlight}` }
          : {})}
        placeholder={
          disabled ? "Solved — see you tomorrow" : "Guess a company…"
        }
        autoComplete="off"
        disabled={disabled}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
      />
      {matches.length > 0 ? (
        <ul className="picker-list" id="picker-listbox" role="listbox">
          {matches.map((company, index) => (
            <li
              key={company.id}
              id={`picker-option-${index}`}
              role="option"
              aria-selected={index === highlight}
              className={index === highlight ? "highlighted" : undefined}
              onMouseEnter={() => setHighlight(index)}
              onMouseDown={(e) => {
                // mousedown, not click: the input must not lose focus before the pick lands.
                e.preventDefault();
                pick(company);
              }}
            >
              <img
                src={company.logoUrl}
                alt=""
                className="logo"
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
              <span>{company.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
