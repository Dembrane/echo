import { SUPPORTED_LANGUAGES } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import React from "react";
import { Link, LinkProps, useParams } from "react-router";

export const I18nLink: React.FC<LinkProps> = ({ to, ...props }) => {
  const { language } = useParams<{ language?: string }>();
  const { language: i18nLanguage } = useLanguage();

  const finalLanguage = language ?? i18nLanguage;

  if (to.toString() === "..") {
    return <Link to={to} {...props} />;
  }

  SUPPORTED_LANGUAGES.map((lang) => `/${lang}`).forEach((lang) => {
    if (to.toString().startsWith(lang)) {
      return <Link to={to} {...props} />;
    }
  });

  const languagePrefix = finalLanguage ? `/${finalLanguage}` : "";
  const modifiedTo = typeof to === "string" ? `${languagePrefix}${to}` : to;

  return <Link className="" to={modifiedTo} {...props} />;
};
