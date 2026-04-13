# Feature Admission Checklist

No context feature should ship until it answers:

1. What document type does it emit?
2. Is it durable or ephemeral?
3. What trust tier does it have?
4. Which output surface uses it?
5. How is it ranked against existing sources?
6. What is the failure mode if it ranks too high?
7. How will it be evaluated?

If a proposed feature cannot answer those questions, it should not land.
