---
title: "{{ replace .Name "-" " " | title }}"
date: {{ .Date }}
draft: false
highlight: false
summary: ""
cover: ""
tags: []
categories: []
---

{{< lead >}}{{ .Title }}{{< /lead >}}

Write the news content here.
