// Candidate A3: frame the application's origin inside an extension document.
document.getElementById("frame").src = new URLSearchParams(location.search).get("src");
